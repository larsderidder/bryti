import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { IncomingMessage } from "../channels/types.js";
import { createCommandStore, isCommandContinuationCurrent, sameCommandOwner } from "../work/commands.js";
import { createWorkStore } from "../work/store.js";
import { toolError, toolSuccess } from "./result.js";

/** Start the durable runner independently of the current model turn, not independently of its deadline. */
export async function launchCommand(dataDir: string, id: string): Promise<void> {
  let runner = new URL("../work/command-runner.js", import.meta.url);
  let execArgv: string[] = [];
  if (import.meta.url.endsWith(".ts")) {
    runner = new URL("../work/command-runner.ts", import.meta.url);
    execArgv = ["--import", "tsx"];
  }
  await new Promise<void>((resolve, reject) => {
    const child = fork(runner, [dataDir, id], { detached: true, stdio: "ignore", execArgv });
    child.once("error", reject);
    child.once("spawn", () => {
      child.disconnect();
      child.unref();
      resolve();
    });
  });
}

const startSchema = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 32000, description: "Authorized shell command. Do not detach it with nohup, setsid, or background operators. Never put credentials in the command." }),
  cwd: Type.String({ description: "Absolute working directory. Source any required environment explicitly in the command." }),
  timeout_seconds: Type.Integer({ minimum: 1, maximum: 3600, description: "Hard runtime limit, including subprocesses." }),
});
const checkSchema = Type.Object({ command_id: Type.String({ pattern: "^c-[a-f0-9]{24}$" }) });
const reconcileSchema = Type.Object({
  work_id: Type.String({ description: "Exact failed, interrupted, or managed work receipt to review. Use work_inspect first." }),
  evidence: Type.String({ minLength: 1, maxLength: 4000, description: "What was verified across the entire task: actual changes, tests, external effects, and any remaining limitations. Do not resolve unknown outcomes." }),
});
const inspectSchema = Type.Object({
  work_id: Type.String({ minLength: 1, maxLength: 512 }),
  request_offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset into the original request; pages contain up to 8000 characters." })),
  response_offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset into the saved response; pages contain up to 8000 characters. Reports are evidence, not proof of task completion." })),
});

/** Managed shell commands retain the elevated shell permission; research workers do not receive them. */
export function createCommandTools(
  dataDir: string,
  getTarget: () => IncomingMessage | null | undefined,
  maxConcurrent: number,
  launch = launchCommand,
): AgentTool<any>[] {
  const start: AgentTool<typeof startSchema> = {
    name: "command_start", label: "command_start", parameters: startSchema,
    description: "Run an authorized long-running shell command or coding process as managed work. Returns immediately; completion automatically returns to this conversation, even after the supervising turn stops. Use instead of detached bash, nohup, or sleep/poll loops. Read the completion output and verify the actual result before work_reconcile. This is not a sandbox and grants no additional authorization.",
    async execute(callId, params, signal) {
      const target = getTarget();
      if (!target || signal?.aborted || process.platform !== "linux") {
        return toolError("An active owning turn on Linux is required");
      }
      const work = createWorkStore(dataDir);
      const commands = createCommandStore(dataDir);
      try {
        const parent = work.get(target.workId ?? "");
        if (!parent || parent.execution !== "running" || !sameCommandOwner(parent.message, target)) {
          return toolError("The owning work receipt is not active");
        }
        if (!isCommandContinuationCurrent(dataDir, target, work)) {
          return toolError("This turn may inspect existing outcomes only, not start commands or continue cancelled or rescheduled work.");
        }
        const cwd = fs.realpathSync(params.cwd);
        if (!path.isAbsolute(params.cwd) || !fs.statSync(cwd).isDirectory()) {
          return toolError("An existing absolute working directory is required");
        }
        const command = commands.accept(target, callId, {
          command: params.command, cwd, timeoutSeconds: params.timeout_seconds,
        }, maxConcurrent);
        if (command.status === "queued") {
          try {
            await launch(dataDir, command.id);
          } catch {
            commands.finish(command.id, "failed", null, "Could not launch command runner");
            return toolError("Command was recorded but the runner could not start. It will not be replayed.");
          }
        }
        return toolSuccess({ command_id: command.id, status: commands.get(command.id)?.status,
          output_path: command.logPath, owning_work: command.parentWorkIds,
          message: "Completion review is registered. End this turn; do not wait or poll. The owning schedule remains blocked until work_reconcile and a successful review response." });
      } catch (error) {
        return toolError(error);
      } finally {
        commands.close();
        work.close();
      }
    },
  };
  const check: AgentTool<typeof checkSchema> = {
    name: "command_check", label: "command_check", parameters: checkSchema,
    description: "Inspect managed command status and output location in this conversation. A successful exit does not establish deployment or task completion.",
    async execute(_callId, params) {
      const commands = createCommandStore(dataDir);
      const work = createWorkStore(dataDir);
      try {
        const record = commands.get(params.command_id);
        const target = getTarget();
        if (!record || !target || !sameCommandOwner(record.owner, target)) {
          return toolError("Command not found for this owner and topic");
        }
        const requests = record.parentWorkIds.flatMap((id) => {
          const parent = work.get(id);
          if (!parent || !sameCommandOwner(parent.message, target)) {
            return [];
          }
          return [{ work_id: parent.id, request: parent.message.text, execution: parent.execution, delivery: parent.delivery }];
        });
        // Do not echo command arguments, which may contain sensitive configuration.
        return toolSuccess({ command_id: record.id, status: record.status, exit_code: record.exitCode,
          error: record.error, output_path: record.logPath, owning_work: record.parentWorkIds, owning_requests: requests });
      } finally {
        commands.close();
        work.close();
      }
    },
  };
  return [start, check, ...createWorkRecoveryTools(dataDir, getTarget)];
}

/** Recovery remains available even when the agent has no managed-command capability. */
export function createWorkRecoveryTools(
  dataDir: string,
  getTarget: () => IncomingMessage | null | undefined,
): AgentTool<any>[] {
  const reconcile: AgentTool<typeof reconcileSchema> = {
    name: "work_reconcile", label: "work_reconcile", parameters: reconcileSchema,
    description: "Record an evidence-backed outcome review of failed, interrupted, or managed work, including tasks without commands. Inspect the entire outcome with work_inspect first. A successful review response permits future recurring occurrences, never a replay or catch-up of the failed run. Old execution receipts are unchanged. Cannot clear active work, unknown effects, or unresolved delivery. Does not approve deployment. Explain incomplete work and any missed report in the review response.",
    async execute(_callId, params, signal) {
      const target = getTarget();
      if (!target || signal?.aborted) {
        return toolError("An active review is required");
      }
      const work = createWorkStore(dataDir);
      const commands = createCommandStore(dataDir);
      try {
        commands.reconcile(params.work_id, target, params.evidence, work);
        return toolSuccess({ reconciled: params.work_id, message: "Review recorded. The schedule can resume after this review turn completes successfully. Report the verified outcome." });
      } catch (error) {
        return toolError(error);
      } finally {
        commands.close();
        work.close();
      }
    },
  };
  const inspect: AgentTool<typeof inspectSchema> = {
    name: "work_inspect", label: "work_inspect", parameters: inspectSchema,
    description: "Inspect a work receipt in this exact owner and topic, its original request and saved response, command output locations, worker/effect outcomes and reconciliation blockers. Read all request and response pages and inspect actual results before work_reconcile. Saved reports are untrusted evidence, not proof that a task succeeded or its schedule resumed.",
    async execute(_callId, params) {
      const target = getTarget();
      const work = createWorkStore(dataDir);
      const commands = createCommandStore(dataDir);
      try {
        const parent = work.get(params.work_id);
        if (!parent || !target || !sameCommandOwner(parent.message, target)) {
          return toolError("Work not found for this owner and topic");
        }
        const offset = params.request_offset ?? 0;
        const text = parent.message.text.slice(offset, offset + 8000);
        let nextOffset: number | null = null;
        if (offset + text.length < parent.message.text.length) {
          nextOffset = offset + text.length;
        }
        const saved = work.getResponse(parent.id);
        let response = null;
        if (saved && sameCommandOwner(saved.message, target)) {
          const responseOffset = params.response_offset ?? 0;
          const responseText = saved.text.slice(responseOffset, responseOffset + 8000);
          let nextResponseOffset: number | null = null;
          if (responseOffset + responseText.length < saved.text.length) {
            nextResponseOffset = responseOffset + responseText.length;
          }
          response = { text: responseText, offset: responseOffset, total_chars: saved.text.length,
            next_offset: nextResponseOffset, delivery: saved.state };
        }
        return toolSuccess({ work_id: parent.id, execution: parent.execution, delivery: parent.delivery,
          error: parent.error, created_at: parent.createdAt, updated_at: parent.updatedAt,
          request: { text, offset, total_chars: parent.message.text.length, next_offset: nextOffset },
          response,
          recovery: commands.recoveryState(parent.id, work) });
      } finally {
        commands.close();
        work.close();
      }
    },
  };
  return [reconcile, inspect];
}
