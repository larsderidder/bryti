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
  work_id: Type.String({ description: "Owning work receipt identified by the command completion event." }),
  evidence: Type.String({ minLength: 1, maxLength: 4000, description: "What was verified across the entire task: actual changes, tests, external effects, and any remaining limitations. Do not resolve unknown outcomes." }),
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
          return toolError("The owning reminder was cancelled or rescheduled. Inspect and report existing results only.");
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
  const reconcile: AgentTool<typeof reconcileSchema> = {
    name: "work_reconcile", label: "work_reconcile", parameters: reconcileSchema,
    description: "Record an evidence-backed resolution of an entire task with managed commands after inspecting its real outcome. This allows its recurring schedule to resume after your review response succeeds. Never use merely because a command exited zero, while effects are unknown, or before authorized release checks finish. Does not replay commands or approve deployment.",
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
  return [start, check, reconcile];
}
