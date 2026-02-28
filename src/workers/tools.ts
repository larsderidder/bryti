/**
 * Worker tools: dispatch, check, interrupt, steer.
 *
 * Workers are background LLM sessions with a scoped tool set. They write
 * results to a file and signal completion by archiving a fact, which triggers
 * any matching projection in the main agent.
 *
 * Lifecycle:
 *   1. dispatch: create worker dir, write task.md, spawn session
 *   2. Worker runs autonomously (web search, fetch URL, write result.md)
 *   3. On completion/failure/timeout: write status.json, archive a fact
 *   4. check: query status; interrupt: cancel immediately; steer: redirect
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { Config } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import { embed } from "../memory/embeddings.js";
import { toolError, toolSuccess } from "../tools/result.js";
import type { WorkerRegistry } from "./registry.js";
import type { ProjectionStore } from "../projection/store.js";
import {
  spawnWorkerSession,
  writeStatusFile,
  type WorkerStatusFile,
  type WorkerTriggerCallback,
} from "./spawn.js";

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

const ALLOWED_TOOLS = ["web_search", "fetch_url"] as const;
type AllowedTool = (typeof ALLOWED_TOOLS)[number];

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Re-export for use in other modules
export type { WorkerTriggerCallback } from "./spawn.js";

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const dispatchWorkerSchema = Type.Object({
  task: Type.String({
    description:
      "Detailed description of what the worker should do. Be specific: include what to search for, " +
      "what sources to look at, and what format the result should take.",
  }),
  type: Type.Optional(Type.String({
    description:
      "Worker type name from config. When set, the worker inherits the type's model, tools, " +
      "and timeout as defaults. Explicit model/tools/timeout_seconds parameters still override.",
  })),
  tools: Type.Optional(Type.Array(
    Type.Union([Type.Literal("web_search"), Type.Literal("fetch_url")]),
    {
      description:
        "Tools the worker may use. Defaults to [\"web_search\", \"fetch_url\"]. " +
        "Omit fetch_url if only keyword search is needed.",
    },
  )),
  model: Type.Optional(Type.String({
    description:
      "Model to use for this worker. Defaults to the type's model if a type is set, " +
      "otherwise the configured worker default.",
  })),
  timeout_seconds: Type.Optional(Type.Number({
    description: "Maximum seconds before the worker is forcibly stopped. Default: 3600 (1 hour).",
  })),
});

const checkWorkerSchema = Type.Object({
  worker_id: Type.String({ description: "The worker_id returned by worker_dispatch." }),
});

const interruptWorkerSchema = Type.Object({
  worker_id: Type.String({ description: "The worker_id returned by worker_dispatch." }),
});

const steerWorkerSchema = Type.Object({
  worker_id: Type.String({ description: "The worker_id returned by worker_dispatch." }),
  guidance: Type.String({
    description:
      "New instructions for the worker. Be specific: what to focus on, what to skip, " +
      "what to add. The worker checks for this after every few tool calls and adjusts accordingly. " +
      "Replaces any prior steering — include everything the worker needs.",
  }),
});

type DispatchWorkerInput = Static<typeof dispatchWorkerSchema>;
type CheckWorkerInput = Static<typeof checkWorkerSchema>;
type InterruptWorkerInput = Static<typeof interruptWorkerSchema>;
type SteerWorkerInput = Static<typeof steerWorkerSchema>;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create worker tools (dispatch, check, interrupt, steer).
 * When isWorkerSession is true, dispatch rejects all calls (no nesting).
 */
export function createWorkerTools(
  config: Config,
  memoryStore: MemoryStore,
  registry: WorkerRegistry,
  isWorkerSession = false,
  projectionStore?: ProjectionStore,
  onTrigger?: WorkerTriggerCallback,
): AgentTool<any>[] {
  // Build description dynamically to include configured worker types
  const types = config.tools.workers.types ?? {};
  const typeNames = Object.keys(types);
  let typesSuffix = "";
  if (typeNames.length > 0) {
    const typeLines = typeNames.map((name) => {
      const t = types[name];
      const parts = [name];
      if (t.description) parts.push(`— ${t.description}`);
      if (t.model) parts.push(`(model: ${t.model})`);
      return parts.join(" ");
    });
    typesSuffix =
      ` Available worker types: ${typeLines.join("; ")}. ` +
      `Set the "type" parameter to use a type's defaults.`;
  }

  const dispatchTool: AgentTool<typeof dispatchWorkerSchema> = {
    name: "worker_dispatch",
    label: "worker_dispatch",
    description:
      "Dispatch a background worker to perform a long-running task (research, content gathering, etc.). " +
      "Returns immediately — the worker runs in the background. " +
      "After dispatching, create a projection with trigger_on_fact matching the worker completion fact " +
      "(e.g. 'worker <id> complete') so you are notified when results are ready. " +
      "Workers can use web_search and fetch_url. They write results to result.md. " +
      `Max ${config.tools.workers.max_concurrent} concurrent workers.` +
      typesSuffix,
    parameters: dispatchWorkerSchema,
    async execute(
      _toolCallId: string,
      { task, type: typeName, tools: requestedTools, model: modelOverride, timeout_seconds }: DispatchWorkerInput,
    ): Promise<AgentToolResult<unknown>> {
      // Hard block: no nesting
      if (isWorkerSession) {
        return toolError("Workers cannot dispatch other workers.");
      }

      // Concurrency limit
      const maxConcurrent = config.tools.workers.max_concurrent;
      if (registry.runningCount() >= maxConcurrent) {
        return toolError(
          `Maximum concurrent workers (${maxConcurrent}) already running. ` +
          `Use worker_check to see current workers, or wait for one to complete.`,
        );
      }

      // Resolve worker type defaults (explicit params override type defaults)
      const workerType = typeName ? config.tools.workers.types?.[typeName] : undefined;
      if (typeName && !workerType) {
        const available = Object.keys(config.tools.workers.types ?? {});
        return toolError(
          `Unknown worker type "${typeName}". ` +
          (available.length > 0
            ? `Available types: ${available.join(", ")}`
            : "No worker types configured."),
        );
      }

      const effectiveTools = requestedTools ?? workerType?.tools ?? ["web_search", "fetch_url"];
      const effectiveTimeout = timeout_seconds ?? workerType?.timeout_seconds;
      const effectiveModel = modelOverride ?? workerType?.model;

      // Validate requested tools
      const toolNames: AllowedTool[] = [];
      for (const t of effectiveTools) {
        if (!ALLOWED_TOOLS.includes(t as AllowedTool)) {
          return toolError(`Unknown tool "${t}". Allowed: ${ALLOWED_TOOLS.join(", ")}`);
        }
        toolNames.push(t as AllowedTool);
      }
      if (toolNames.length === 0) {
        toolNames.push("web_search", "fetch_url");
      }

      // Create worker directory
      const workerId = `w-${crypto.randomUUID().slice(0, 8)}`;
      const workerDir = path.join(config.data_dir, "files", "workers", workerId);
      fs.mkdirSync(workerDir, { recursive: true });

      // Write task brief
      fs.writeFileSync(path.join(workerDir, "task.md"), task, "utf-8");

      const timeoutMs = effectiveTimeout ? effectiveTimeout * 1000 : DEFAULT_TIMEOUT_MS;
      // Resolve display model for registry/logs. The actual model resolution
      // (with fallback chain) happens inside spawnWorkerSession.
      const displayModel = effectiveModel
        ?? config.tools.workers.model
        ?? config.agent.fallback_models?.[0]
        ?? config.agent.model;
      const resultPath = path.join(workerDir, "result.md");

      // Register immediately so worker_check can find it
      registry.register({
        workerId,
        status: "running",
        task,
        resultPath,
        workerDir,
        startedAt: new Date(),
        error: null,
        model: displayModel,
        abort: null,
        timeoutHandle: null,
      });

      // Write initial status.json
      writeStatusFile(workerDir, {
        worker_id: workerId,
        status: "running",
        task,
        started_at: new Date().toISOString(),
        completed_at: null,
        model: displayModel,
        error: null,
        result_path: resultPath,
      });

      console.log(`[worker] Dispatching ${workerId} (model: ${displayModel}, tools: ${toolNames.join(", ")})`);

      // Spawn in background — intentionally not awaited
      spawnWorkerSession({
        config,
        workerId,
        workerDir,
        task,
        modelOverride: effectiveModel,
        toolNames,
        memoryStore,
        projectionStore,
        registry,
        timeoutMs,
        onTrigger,
      }).catch((err: Error) => {
        console.error(`[worker] ${workerId} spawn failed:`, err.message);
        registry.update(workerId, {
          status: "failed",
          completedAt: new Date(),
          error: `Spawn failed: ${err.message}`,
        });
      });

      // Return immediately — worker is running in the background
      // Path relative to the file sandbox base (data/files/), not data_dir,
      // so it's directly usable with file_read.
      const filesBase = path.join(config.data_dir, "files");
      const relativeResultPath = path.relative(filesBase, resultPath);
      return toolSuccess({
        worker_id: workerId,
        status: "running",
        result_path: relativeResultPath,
        trigger_hint: `worker ${workerId} complete`,
        note:
          `Worker dispatched. Create a projection with trigger_on_fact: "worker ${workerId} complete" ` +
          `to be notified when results are ready. Read results with file_read path: ${relativeResultPath}`,
      });
    },
  };

  const checkTool: AgentTool<typeof checkWorkerSchema> = {
    name: "worker_check",
    label: "worker_check",
    description:
      "Check the status of a background worker. " +
      "Use when the user asks how a task is progressing, or to verify completion before reading results.",
    parameters: checkWorkerSchema,
    async execute(
      _toolCallId: string,
      { worker_id }: CheckWorkerInput,
    ): Promise<AgentToolResult<unknown>> {
      const entry = registry.get(worker_id);
      if (!entry) {
        // Try reading from status.json on disk as a fallback (survives restarts)
        const workerDir = path.join(config.data_dir, "files", "workers", worker_id);
        const statusFile = path.join(workerDir, "status.json");
        if (fs.existsSync(statusFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(statusFile, "utf-8")) as WorkerStatusFile;
            const filesBase = path.join(config.data_dir, "files");
            const relResult = path.relative(filesBase, data.result_path);
            const elapsed = data.completed_at
              ? Math.round((new Date(data.completed_at).getTime() - new Date(data.started_at).getTime()) / 60000)
              : null;
            return toolSuccess({
              worker_id: data.worker_id,
              status: data.status,
              elapsed_minutes: elapsed,
              result_path: relResult,
              error: data.error ?? undefined,
              note: `Status read from disk. Read results with file_read path: ${relResult}`,
            });
          } catch {
            // Fall through to not-found
          }
        }
        return toolError(`Worker not found: ${worker_id}`);
      }

      const elapsedMs = Date.now() - entry.startedAt.getTime();
      const elapsedMinutes = Math.round(elapsedMs / 60000);
      const filesBase = path.join(config.data_dir, "files");
      const relativeResultPath = path.relative(filesBase, entry.resultPath);

      return toolSuccess({
        worker_id: entry.workerId,
        status: entry.status,
        elapsed_minutes: elapsedMinutes,
        result_path: relativeResultPath,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.status === "complete" ? { note: `Read results with file_read path: ${relativeResultPath}` } : {}),
      });
    },
  };

  const interruptTool: AgentTool<typeof interruptWorkerSchema> = {
    name: "worker_interrupt",
    label: "worker_interrupt",
    description:
      "Cancel a running background worker immediately. " +
      "Use when the task is no longer needed, the user asks you to stop it, or the worker is taking too long. " +
      "If the worker has already finished, this is a no-op and returns the current status.",
    parameters: interruptWorkerSchema,
    async execute(
      _toolCallId: string,
      { worker_id }: InterruptWorkerInput,
    ): Promise<AgentToolResult<unknown>> {
      const entry = registry.get(worker_id);

      if (!entry) {
        // Check disk as a fallback (worker may have been cleaned up from registry)
        const workerDir = path.join(config.data_dir, "files", "workers", worker_id);
        const statusFile = path.join(workerDir, "status.json");
        if (fs.existsSync(statusFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(statusFile, "utf-8")) as WorkerStatusFile;
            return toolSuccess({
              worker_id,
              status: data.status,
              note: `Worker already finished with status "${data.status}". Nothing to interrupt.`,
            });
          } catch {
            // Fall through
          }
        }
        return toolError(`Worker not found: ${worker_id}`);
      }

      // Already in a terminal state — nothing to do
      if (entry.status !== "running") {
        return toolSuccess({
          worker_id,
          status: entry.status,
          note: `Worker already in terminal state "${entry.status}". Nothing to interrupt.`,
        });
      }

      // Cancel the timeout so it doesn't fire after we've already cancelled
      if (entry.timeoutHandle) {
        clearTimeout(entry.timeoutHandle);
      }

      // Mark cancelled before calling abort() so the spawnWorkerSession catch
      // block sees the terminal status and skips overwriting it
      const cancelledAt = new Date();
      registry.update(worker_id, {
        status: "cancelled",
        completedAt: cancelledAt,
        error: null,
        timeoutHandle: null,
      });

      writeStatusFile(path.join(config.data_dir, "files", "workers", worker_id), {
        worker_id,
        status: "cancelled",
        task: entry.task,
        started_at: entry.startedAt.toISOString(),
        completed_at: cancelledAt.toISOString(),
        model: entry.model,
        error: null,
        result_path: entry.resultPath,
      });

      // Abort the session if it's running. abort() may throw — treat as best-effort
      if (entry.abort) {
        try {
          await entry.abort();
        } catch {
          // Best-effort — the status is already set to cancelled
        }
      }

      // Archive a cancellation fact so any projections watching this worker can clean up
      const modelsDir = path.join(config.data_dir, ".models");
      const factContent = `Worker ${worker_id} cancelled`;
      try {
        const embedding = await embed(factContent, modelsDir);
        memoryStore.addFact(factContent, "worker", embedding);
        console.log(`[worker] ${worker_id} cancellation fact archived`);
      } catch (err) {
        console.error(`[worker] ${worker_id} failed to archive cancellation fact:`, (err as Error).message);
      }

      console.log(`[worker] ${worker_id} cancelled`);

      return toolSuccess({
        worker_id,
        status: "cancelled",
        note: "Worker has been cancelled. Any partial results may still exist in the worker directory.",
      });
    },
  };

  const steerTool: AgentTool<typeof steerWorkerSchema> = {
    name: "worker_steer",
    label: "worker_steer",
    description:
      "Send updated guidance to a running background worker. " +
      "The worker checks for a steering.md file after every few tool calls and incorporates the instructions. " +
      "Use this to narrow focus, redirect research, add requirements, or correct course mid-task. " +
      "Each call replaces the previous steering note — include everything the worker needs. " +
      "Has no effect on workers that have already finished.",
    parameters: steerWorkerSchema,
    async execute(
      _toolCallId: string,
      { worker_id, guidance }: SteerWorkerInput,
    ): Promise<AgentToolResult<unknown>> {
      const entry = registry.get(worker_id);

      if (!entry) {
        return toolError(`Worker not found: ${worker_id}`);
      }

      if (entry.status !== "running") {
        return toolSuccess({
          worker_id,
          status: entry.status,
          note: `Worker is already in terminal state "${entry.status}". Steering has no effect.`,
        });
      }

      const steeringPath = path.join(entry.workerDir, "steering.md");
      try {
        fs.writeFileSync(steeringPath, guidance, "utf-8");
      } catch (error) {
        return toolError(error, "Failed to write steering note");
      }

      console.log(`[worker] ${worker_id} steering note updated (${Buffer.byteLength(guidance, "utf-8")} bytes)`);

      return toolSuccess({
        worker_id,
        status: "running",
        note:
          "Steering note written. The worker will pick it up after its next few tool calls " +
          "and adjust its work accordingly.",
      });
    },
  };

  return [dispatchTool, checkTool, interruptTool, steerTool];
}
