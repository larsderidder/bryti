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
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { Config } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import { embed } from "../memory/embeddings.js";
import { toolError, toolSuccess } from "../tools/result.js";
import type { WorkerEntry, WorkerRegistry } from "./registry.js";
import type { ProjectionStore, ProjectionTarget } from "../projection/store.js";
import { registerWorkerOwner } from "./recovery.js";
import { WorkerLifecycle, stopWorker, commitWorkerOutcome } from "./lifecycle.js";
import { hashToolArgs } from "../trust/store.js";
import { sameWorkerOwner, workerIdentity, withWorkerStore, type WorkerLaunchSpec, type WorkerReceipt } from "./store.js";
import { writeTextAtomic } from "../durable-file.js";
import { isInternalMessage, type IncomingMessage } from "../channels/types.js";
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
        "Optional extra tools the worker may use. fetch_url and scoped file tools are always available. " +
        "Omit to inherit the worker type's tools or default to [\"web_search\", \"fetch_url\"]. " +
        "Pass [] for code-only review or analysis that does not require web research.",
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
  max_turns: Type.Optional(Type.Number({
    description:
      "Maximum worker turns before Bryti asks the worker to wrap up. " +
      "Defaults to tools.workers.max_turns when configured.",
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
  getTarget?: () => ProjectionTarget | null | undefined,
  lifecycle = new WorkerLifecycle(),
  getWorkTarget?: () => IncomingMessage | null | undefined,
): AgentTool<any>[] {
  // Build description dynamically to include configured worker types
  const types = config.tools.workers.types ?? {};
  const typeNames = Object.keys(types);
  let typesSuffix = "";
  const fallbackScope = crypto.randomUUID();
  lifecycle.register(registry);

  function filesBase(): string {
    return path.join(config.data_dir, "files");
  }

  function relativeResultPath(resultPath: string): string {
    return path.relative(filesBase(), resultPath);
  }

  function currentOwner(): IncomingMessage | undefined {
    const target = getWorkTarget?.() ?? getTarget?.();
    if (!target) {
      return undefined;
    }
    const work = target as IncomingMessage;
    return { userId: target.userId, platform: target.platform as IncomingMessage["platform"], channelId: target.channelId,
      threadId: target.threadId, channelThreadId: target.channelThreadId,
      workId: work.workId, workIds: work.workIds, text: "", raw: null };
  }

  function workerDirectory(workerId: string): string {
    if (!/^w-[a-f0-9]{8}$/.test(workerId)) {
      throw new Error("Invalid worker identity");
    }
    return path.join(config.data_dir, "files", "workers", workerId);
  }

  function validWorkerAccess(workerId: string): boolean {
    if (!/^w-[a-zA-Z0-9-]+$/.test(workerId)) {
      return false;
    }
    const receipt = withWorkerStore(config.data_dir, (store) => store.get(workerId));
    const owner = currentOwner();
    if (receipt?.spec.owner) {
      return sameWorkerOwner(receipt.spec.owner, owner);
    }
    if (!owner) {
      return true;
    }
    try {
      const legacy = JSON.parse(fs.readFileSync(path.join(config.data_dir, "work", "worker-owners", `${workerId}.json`), "utf8"));
      return sameWorkerOwner(legacy, owner);
    } catch {
      return false;
    }
  }

  function registerReceipt(receipt: WorkerReceipt): WorkerEntry {
    const workerDir = workerDirectory(receipt.sessionId);
    try {
      fs.mkdirSync(workerDir, { recursive: true, mode: 0o700 });
      writeTextAtomic(path.join(workerDir, "task.md"), receipt.spec.task);
      if (receipt.spec.owner) {
        registerWorkerOwner(config.data_dir, receipt.workerId, receipt.spec.owner);
      }
    } catch (error) {
      withWorkerStore(config.data_dir, (store) => store.finish(receipt.workerId, "failed", "Worker artifacts could not be initialized. No worker was started."));
      throw error;
    }
    return registry.register({
      workerId: receipt.workerId, status: receipt.status, task: receipt.spec.task,
      workerDir, resultPath: path.join(workerDir, "result.md"), model: receipt.model,
      startedAt: new Date(receipt.startedAt ?? receipt.createdAt), error: receipt.error,
      abort: null, timeoutHandle: null, dataDir: config.data_dir,
      pendingSteering: receipt.pendingSteering,
      queueOrder: receipt.queueOrder,
    });
  }

  function acceptWorker(receipt: WorkerReceipt): AgentToolResult<unknown> {
    let entry = registry.get(receipt.workerId);
    if (!entry && receipt.status === "queued" && !lifecycle.hasWorker(receipt.workerId)) {
      entry = registerReceipt(receipt);
    }
    lifecycle.drainQueues();
    const current = withWorkerStore(config.data_dir, (store) => store.get(receipt.workerId))!;
    return toolSuccess({ worker_id: receipt.workerId, status: current.status,
      queue_position: lifecycle.queuePosition(receipt.workerId),
      result_path: relativeResultPath(path.join(workerDirectory(receipt.sessionId), "result.md")),
      trigger_hint: `worker ${receipt.workerId} complete`,
      note: "Worker accepted durably. Completion notifications are automatic. Read results with read path: "
        + relativeResultPath(path.join(workerDirectory(receipt.sessionId), "result.md")),
    });
  }

  function startWorker(entry: WorkerEntry, spec: WorkerLaunchSpec): void {
    if (lifecycle.stopping || (entry.status !== "running" && entry.status !== "queued")) {
      return;
    }
    const claimed = withWorkerStore(config.data_dir, (store) => store.claim(entry.workerId));
    if (!claimed) {
      registry.remove(entry.workerId);
      return;
    }
    if (claimed.deadlineAt && Date.parse(claimed.deadlineAt) <= Date.now()) {
      commitWorkerOutcome(registry, entry, "timeout", "The original worker deadline expired; no continuation was started.");
      return;
    }
    registry.update(entry.workerId, { status: "running", error: null, runActive: true });
    entry.pendingSteering = claimed.pendingSteering;
    writeStatusFile(entry.workerDir, {
      worker_id: entry.workerId, status: "running", task: entry.task,
      started_at: entry.startedAt.toISOString(), completed_at: null,
      model: entry.model, error: null, result_path: entry.resultPath,
    });

    console.log(
      `[worker] Dispatching ${entry.workerId} ` +
      `(model: ${entry.model}, thinking: ${spec.thinkingLevel}, tools: ${spec.toolNames.join(", ")})`,
    );

    const deadlineTimer = setTimeout(() => {
      void stopWorker(registry, entry, "timeout", "The original worker deadline expired").catch((error) => {
        console.warn(`[worker] ${entry.workerId} deadline settlement failed:`, error);
      });
    }, Math.max(1, Date.parse(claimed.deadlineAt!) - Date.now()));
    const run = spawnWorkerSession({
      config,
      workerId: entry.workerId,
      owner: spec.owner,
      workerDir: entry.workerDir,
      task: spec.task,
      modelOverride: spec.modelOverride,
      thinkingLevel: spec.thinkingLevel,
      toolNames: spec.toolNames,
      memoryStore,
      projectionStore,
      registry,
      timeoutMs: Math.max(1, Date.parse(claimed.deadlineAt!) - Date.now()),
      maxTurns: spec.maxTurns,
      modelCandidates: spec.modelCandidates,
      sessionId: claimed.sessionId,
      initialProgress: claimed.progress,
      onTrigger,
    }).catch((err: Error) => {
      if (entry.status !== "running") {
        return;
      }
      console.error(`[worker] ${entry.workerId} spawn failed:`, err.message);
      commitWorkerOutcome(registry, entry, "failed", `Spawn failed: ${err.message}`);
    }).finally(() => {
      clearTimeout(deadlineTimer);
      if (entry.status === "stopping") {
        commitWorkerOutcome(registry, entry, entry.stopStatus ?? "interrupted", entry.error);
      }
      registry.update(entry.workerId, { runActive: false });
      lifecycle.drainQueues();
    });
    lifecycle.track(run);
  }

  function drainQueue(workerId: string): void {
    if (lifecycle.stopping || lifecycle.runningCount() >= config.tools.workers.max_concurrent) {
      return;
    }
    const next = registry.get(workerId);
    if (!next || next.status !== "queued") {
      return;
    }
    const receipt = withWorkerStore(config.data_dir, (store) => store.get(next.workerId));
    if (!receipt) {
      commitWorkerOutcome(registry, next, "failed", "Queued worker lost its launch specification");
      return;
    }
    startWorker(next, receipt.spec);
  }

  if (typeNames.length > 0) {
    const typeLines = typeNames.map((name) => {
      const t = types[name];
      const parts = [name];
      if (t.description) parts.push(`— ${t.description}`);
      if (t.model) parts.push(`(model: ${t.model})`);
      if (t.thinking_level) parts.push(`(thinking: ${t.thinking_level})`);
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
      "Completion and interruption notifications are delivered automatically to the originating conversation. " +
      "Workers always have fetch_url for URL extraction and can use web_search when configured. " +
      "When Parallel is enabled, workers requesting web_search also receive parallel_search and parallel_fetch. " +
      "Workers write results to result.md. " +
      `Max ${config.tools.workers.max_concurrent} concurrent workers.` +
      typesSuffix,
    parameters: dispatchWorkerSchema,
    async execute(
      toolCallId: string,
      { task, type: typeName, tools: requestedTools, model: modelOverride, timeout_seconds, max_turns }: DispatchWorkerInput,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> {
      // Hard block: no nesting
      if (isWorkerSession) {
        return toolError("Workers cannot dispatch other workers.");
      }
      if (lifecycle.stopping) {
        return toolError("Bryti is shutting down. No worker was started.");
      }
      if (signal?.aborted) {
        return toolError("Worker dispatch was cancelled before acceptance.");
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

      // An explicit empty list opts out of research; only omitted tools inherit defaults.
      const effectiveTools = requestedTools ?? workerType?.tools ?? ["web_search", "fetch_url"];
      const effectiveTimeout = timeout_seconds ?? workerType?.timeout_seconds;
      const effectiveModel = modelOverride ?? workerType?.model;
      const effectiveThinkingLevel = workerType?.thinking_level
        ?? config.tools.workers.thinking_level
        ?? config.agent.thinking_level;

      // Validate requested tools
      const toolNames: AllowedTool[] = [];
      for (const t of effectiveTools) {
        if (!ALLOWED_TOOLS.includes(t as AllowedTool)) {
          return toolError(`Unknown tool "${t}". Allowed: ${ALLOWED_TOOLS.join(", ")}`);
        }
        toolNames.push(t as AllowedTool);
      }

      let timeoutMs = DEFAULT_TIMEOUT_MS;
      if (effectiveTimeout !== undefined) {
        timeoutMs = effectiveTimeout * 1000;
      }
      if (!task.trim() || task.length > 100_000 || !Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
        return toolError("A non-empty bounded task and timeout between 1 and 3600 seconds are required.");
      }
      const modelCandidates = [...new Set([effectiveModel, config.tools.workers.model,
        ...(config.agent.fallback_models ?? []), config.agent.model].filter((model): model is string => Boolean(model)))];
      const displayModel = modelCandidates[0];

      const launchSpec: WorkerLaunchSpec = {
        task,
        modelOverride: effectiveModel,
        modelCandidates,
        thinkingLevel: effectiveThinkingLevel,
        toolNames,
        timeoutMs,
        maxTurns: max_turns ?? workerType?.max_turns ?? config.tools.workers.max_turns,
      };
      if (launchSpec.maxTurns !== undefined && (!Number.isSafeInteger(launchSpec.maxTurns) || launchSpec.maxTurns <= 0)) {
        return toolError("The worker turn budget must be a positive integer");
      }
      launchSpec.owner = currentOwner();

      try {
        const receipt = withWorkerStore(config.data_dir, (store) => store.accept(
          workerIdentity(launchSpec.owner, toolCallId, fallbackScope), launchSpec, displayModel, undefined,
          hashToolArgs({ task, type: typeName, tools: requestedTools, model: modelOverride, timeout_seconds, max_turns }),
        ));
        return acceptWorker(receipt);
      } catch (error) {
        return toolError(error, "Worker acceptance failed. No unrecorded worker was started");
      }
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
      if (!validWorkerAccess(worker_id)) {
        return toolError("Worker not found for this owner and topic");
      }
      const receipt = withWorkerStore(config.data_dir, (store) => store.get(worker_id));
      if (receipt) {
        return toolSuccess({ worker_id, status: receipt.status, error: receipt.error,
          progress: receipt.progress, stop_status: receipt.stopStatus,
          result_hash: receipt.resultHash, result_path: relativeResultPath(workerDirectory(receipt.sessionId) + "/result.md") });
      }
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
              ...(data.queue_position ? { queue_position: data.queue_position } : {}),
              ...(data.transcript_path ? { transcript_path: path.relative(filesBase, data.transcript_path) } : {}),
              ...(data.output_path ? { output_path: path.relative(filesBase, data.output_path) } : {}),
              ...(data.progress ? { progress: data.progress } : {}),
              error: data.error ?? undefined,
              note: `Status read from disk. Read results with read path: ${relResult}`,
            });
          } catch {
            // Fall through to not-found
          }
        }
        return toolError(`Worker not found: ${worker_id}`);
      }

      const elapsedMs = Date.now() - entry.startedAt.getTime();
      const elapsedMinutes = Math.round(elapsedMs / 60000);
      const statusFile = path.join(entry.workerDir, "status.json");
      const diskStatus = fs.existsSync(statusFile)
        ? JSON.parse(fs.readFileSync(statusFile, "utf-8")) as WorkerStatusFile
        : null;
      const base = filesBase();
      const relResult = relativeResultPath(entry.resultPath);
      const queuePosition = registry.queuePosition(entry.workerId);

      return toolSuccess({
        worker_id: entry.workerId,
        status: entry.status,
        elapsed_minutes: elapsedMinutes,
        result_path: relResult,
        ...(queuePosition ? { queue_position: queuePosition } : {}),
        ...(diskStatus?.transcript_path ? { transcript_path: path.relative(base, diskStatus.transcript_path) } : {}),
        ...(diskStatus?.output_path ? { output_path: path.relative(base, diskStatus.output_path) } : {}),
        ...(diskStatus?.progress ? { progress: diskStatus.progress } : {}),
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.status === "complete" ? { note: `Read results with read path: ${relResult}` } : {}),
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
      if (!validWorkerAccess(worker_id)) {
        return toolError("Worker not found for this owner and topic");
      }
      const workerRegistry = lifecycle.findWorker(worker_id)?.registry ?? registry;
      const entry = workerRegistry.get(worker_id);

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

      if (entry.status === "queued") {
        await stopWorker(workerRegistry, entry, "cancelled", null);
        return toolSuccess({
          worker_id,
          status: "cancelled",
          note: "Queued worker has been cancelled before it started.",
        });
      }

      // Already in a terminal state — nothing to do
      if (entry.status !== "running") {
        return toolSuccess({
          worker_id,
          status: entry.status,
          note: `Worker already in terminal state "${entry.status}". Nothing to interrupt.`,
        });
      }

      // stopWorker persists cancellation before aborting and refuses terminal transitions.
      await stopWorker(workerRegistry, entry, "cancelled", null);

      // Archive a cancellation fact so any projections watching this worker can clean up
      const modelsDir = path.join(config.data_dir, ".models");
      const factContent = `Worker ${worker_id} ${entry.status}`;
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
        status: entry.status,
        note: "Cancellation requested. A draining worker retains its slot until execution settles. Partial results may remain.",
      });
    },
  };

  const steerTool: AgentTool<typeof steerWorkerSchema> = {
    name: "worker_steer",
    label: "worker_steer",
    description:
      "Send updated guidance to a running background worker. " +
      "The guidance is injected directly into the worker session and delivered after the current tool execution. " +
      "Use this to narrow focus, redirect research, add requirements, or correct course mid-task. " +
      "If the worker session is still starting, only the latest guidance is queued and delivered once it is ready. " +
      "Has no effect on workers that have already finished.",
    parameters: steerWorkerSchema,
    async execute(
      _toolCallId: string,
      { worker_id, guidance }: SteerWorkerInput,
    ): Promise<AgentToolResult<unknown>> {
      if (!validWorkerAccess(worker_id) || guidance.length > 16_000) {
        return toolError("Worker not found for this owner and topic, or guidance exceeds the limit");
      }
      withWorkerStore(config.data_dir, (store) => store.steer(worker_id, guidance));
      const workerRegistry = lifecycle.findWorker(worker_id)?.registry ?? registry;
      const entry = workerRegistry.get(worker_id);

      if (!entry) {
        return toolError(`Worker not found: ${worker_id}`);
      }

      if (entry.status === "queued") {
        workerRegistry.update(worker_id, { pendingSteering: guidance });
        return toolSuccess({
          worker_id,
          status: "queued",
          note: "Worker is queued. Steering guidance will be delivered when it starts.",
        });
      }

      if (entry.status !== "running") {
        return toolSuccess({
          worker_id,
          status: entry.status,
          note: `Worker is already in terminal state "${entry.status}". Steering has no effect.`,
        });
      }

      if (!entry.steer) {
        workerRegistry.update(worker_id, { pendingSteering: guidance });
        console.log(`[worker] ${worker_id} steering queued (${Buffer.byteLength(guidance, "utf-8")} bytes)`);
        return toolSuccess({
          worker_id,
          status: "running",
          note: "Worker session is still starting. Steering guidance queued and will be delivered once ready.",
        });
      }

      try {
        await entry.steer(guidance);
      } catch (error) {
        return toolError(error, "Failed to steer worker");
      }

      console.log(`[worker] ${worker_id} steered (${Buffer.byteLength(guidance, "utf-8")} bytes)`);

      return toolSuccess({
        worker_id,
        status: "running",
        note: "Steering guidance delivered to the worker session.",
      });
    },
  };

  const resumeTool: AgentTool<typeof checkWorkerSchema> = {
    name: "worker_resume", label: "worker_resume", parameters: checkWorkerSchema,
    description: "Continue an interrupted or failed worker conversation only after an explicit user request. Creates a new receipt with the same conversation, original deadline and turn budget. Cancelled or completed workers cannot resume. No tool calls are automatically replayed.",
    async execute(callId, { worker_id }, signal) {
      const target = getWorkTarget?.();
      if (isWorkerSession || (target && isInternalMessage(target))) {
        return toolError("Worker continuation requires a new user request, not an automation event");
      }
      if (lifecycle.stopping || signal?.aborted || !validWorkerAccess(worker_id)) {
        return toolError("Worker continuation is unavailable for this owner");
      }
      const prior = withWorkerStore(config.data_dir, (store) => store.get(worker_id));
      if (!prior || !["interrupted", "failed"].includes(prior.status) || lifecycle.findWorker(worker_id)?.entry.runActive) {
        return toolError("Only a settled interrupted or failed worker can continue");
      }
      if (!prior.deadlineAt || Date.parse(prior.deadlineAt) <= Date.now()
        || (prior.spec.maxTurns && (prior.progress?.turns_completed ?? 0) >= prior.spec.maxTurns)) {
        return toolError("The original worker budget is exhausted. Dispatch a new task with fresh authorization instead.");
      }
      try {
        const receipt = withWorkerStore(config.data_dir, (store) => store.accept(
          workerIdentity(currentOwner(), callId, fallbackScope), prior.spec, prior.model, prior, hashToolArgs({ worker_id }),
        ));
        return acceptWorker(receipt);
      } catch (error) {
        return toolError(error, "Worker continuation was not accepted");
      }
    },
  };

  lifecycle.addDrain(registry, drainQueue);
  const owner = currentOwner();
  if (owner) {
    for (const receipt of withWorkerStore(config.data_dir, (store) => store.list())) {
      if (receipt.status === "queued" && sameWorkerOwner(receipt.spec.owner, owner) && !lifecycle.hasWorker(receipt.workerId)) {
        registerReceipt(receipt);
      }
    }
    lifecycle.drainQueues();
  }
  return [dispatchTool, checkTool, interruptTool, steerTool, resumeTool];
}
