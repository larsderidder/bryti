/**
 * Worker tools: dispatch_worker and check_worker.
 *
 * Workers are stateless background LLM sessions that run independently of the
 * main agent. They have a scoped tool set, write results to a file, and signal
 * completion by inserting an archival fact (which triggers any matching
 * trigger_on_fact projection the main agent has set up).
 *
 * Lifecycle:
 *   1. dispatch_worker → creates worker dir, writes task.md, spawns session
 *   2. Worker runs (web search, fetch URL, write to result.md)
 *   3. On completion (or failure/timeout), pibot:
 *      - writes status.json
 *      - archives a completion fact into the user's memory store
 *   4. check_worker → query current status of a worker
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import {
  createAgentSession,
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { Config } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import { embed } from "../memory/embeddings.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { createFetchUrlTool } from "../tools/fetch-url.js";
import { createWorkerScopedTools } from "./scoped-tools.js";
import { toolError, toolSuccess } from "../tools/result.js";
import type { WorkerRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_WORKERS = 3;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

// ---------------------------------------------------------------------------
// Worker system prompt
// ---------------------------------------------------------------------------

function buildWorkerSystemPrompt(task: string, workerDir: string): string {
  return [
    `You are a research worker. Your task is described below.`,
    ``,
    `Write your findings to result.md in your working directory.`,
    `Structure the output as markdown with clear sections.`,
    `Be thorough but concise. Include sources where relevant.`,
    ``,
    `Rules:`,
    `- Your working directory is the root path you have access to.`,
    `- Write your main output to result.md.`,
    `- You may create additional files (notes.md, sources.md, etc.) as needed.`,
    `- Do not ask for feedback or confirmation. Work autonomously.`,
    `- When you are done, stop. Write your last thoughts to result.md and end.`,
    ``,
    `## Task`,
    ``,
    task,
    ``,
    `## Working directory`,
    ``,
    workerDir,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Status file helpers
// ---------------------------------------------------------------------------

interface WorkerStatusFile {
  worker_id: string;
  status: "running" | "complete" | "failed" | "timeout" | "cancelled";
  task: string;
  started_at: string;
  completed_at: string | null;
  model: string;
  error: string | null;
  result_path: string;
}

function writeStatusFile(workerDir: string, data: WorkerStatusFile): void {
  try {
    fs.writeFileSync(
      path.join(workerDir, "status.json"),
      JSON.stringify(data, null, 2),
      "utf-8",
    );
  } catch {
    // Best-effort — don't crash the completion handler
  }
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const ALLOWED_TOOLS = ["web_search", "fetch_url"] as const;
type AllowedTool = (typeof ALLOWED_TOOLS)[number];

const dispatchWorkerSchema = Type.Object({
  task: Type.String({
    description:
      "Detailed description of what the worker should do. Be specific: include what to search for, " +
      "what sources to look at, and what format the result should take.",
  }),
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
      "Model to use for this worker. Defaults to the agent's configured model. " +
      "Use a cheaper/faster model for simple research tasks.",
  })),
  timeout_seconds: Type.Optional(Type.Number({
    description: "Maximum seconds before the worker is forcibly stopped. Default: 3600 (1 hour).",
  })),
});

const checkWorkerSchema = Type.Object({
  worker_id: Type.String({ description: "The worker_id returned by dispatch_worker." }),
});

type DispatchWorkerInput = Static<typeof dispatchWorkerSchema>;
type CheckWorkerInput = Static<typeof checkWorkerSchema>;

// ---------------------------------------------------------------------------
// Models.json for worker sessions
// ---------------------------------------------------------------------------

function ensureWorkerAgentDir(config: Config): string {
  const agentDir = path.join(config.data_dir, ".pi");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, "auth"), { recursive: true });
  return agentDir;
}

// ---------------------------------------------------------------------------
// Worker session spawner
// ---------------------------------------------------------------------------

/**
 * Spawn the worker session in the background. Returns immediately.
 * Completion (success or failure) is handled asynchronously.
 */
async function spawnWorkerSession(opts: {
  config: Config;
  workerId: string;
  workerDir: string;
  task: string;
  modelOverride: string | undefined;
  toolNames: AllowedTool[];
  memoryStore: MemoryStore;
  registry: WorkerRegistry;
  timeoutMs: number;
}): Promise<void> {
  const {
    config,
    workerId,
    workerDir,
    task,
    modelOverride,
    toolNames,
    memoryStore,
    registry,
    timeoutMs,
  } = opts;

  const agentDir = ensureWorkerAgentDir(config);
  const modelsDir = path.join(config.data_dir, ".models");
  const resultPath = path.join(workerDir, "result.md");

  // Auth
  const authStorage = new AuthStorage(path.join(agentDir, "auth", "auth.json"));
  for (const provider of config.models.providers) {
    if (provider.api_key) {
      authStorage.setRuntimeApiKey(provider.name, provider.api_key);
    }
  }

  // Model registry (reuses the same models.json as the main agent)
  const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
  modelRegistry.refresh();

  // Resolve model
  const modelString = modelOverride ?? config.agent.model;
  const [providerName, modelId] = modelString.includes("/")
    ? modelString.split("/", 2)
    : [modelString, modelString];

  let model = modelRegistry.find(providerName, modelId);
  if (!model) {
    const available = modelRegistry.getAvailable();
    model = available.find(
      (m) => m.provider === providerName && m.id.includes(modelId),
    );
  }
  if (!model) {
    throw new Error(`Worker model not found: ${modelString}`);
  }

  // Build scoped tools: only the requested ones + scoped file tools (always)
  const workerTools: AgentTool<any>[] = [];

  if (toolNames.includes("web_search") && config.tools.web_search.enabled) {
    workerTools.push(createWebSearchTool(config.tools.web_search.searxng_url));
  }
  if (toolNames.includes("fetch_url") && config.tools.fetch_url.enabled) {
    workerTools.push(createFetchUrlTool(config.tools.fetch_url.timeout_ms));
  }

  // Scoped file tools: worker can only write to its own directory (flat, no subdirs)
  workerTools.push(...createWorkerScopedTools(workerDir));

  // Minimal resource loader — just the system prompt, no extensions
  const systemPrompt = buildWorkerSystemPrompt(task, workerDir);
  const loader = new DefaultResourceLoader({
    cwd: config.data_dir,
    agentDir,
    settingsManager: SettingsManager.create(config.data_dir, agentDir),
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  const settingsManager = SettingsManager.create(config.data_dir, agentDir);

  // Spawn the session (no persistence — in-memory only)
  const { session } = await createAgentSession({
    cwd: workerDir,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "off",
    tools: [],
    customTools: workerTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(workerDir),
    settingsManager,
  });

  // Register the abort function now that we have the session
  registry.update(workerId, {
    abort: () => session.abort(),
  });

  // Set up timeout
  const timeoutHandle = setTimeout(async () => {
    console.log(`[worker] ${workerId} timed out after ${timeoutMs / 1000}s`);
    registry.update(workerId, {
      status: "timeout",
      completedAt: new Date(),
      error: `Timed out after ${timeoutMs / 1000}s`,
    });
    const entry = registry.get(workerId);
    try {
      await session.abort();
    } catch {
      // Best-effort abort
    }
    session.dispose();
    if (entry) {
      writeStatusFile(workerDir, {
        worker_id: workerId,
        status: "timeout",
        task,
        started_at: entry.startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        model: modelString,
        error: `Timed out after ${timeoutMs / 1000}s`,
        result_path: resultPath,
      });
      const factContent = `Worker ${workerId} failed: timed out after ${timeoutMs / 1000}s`;
      try {
        const embedding = await embed(factContent, modelsDir);
        memoryStore.addFact(factContent, "worker", embedding);
        console.log(`[worker] ${workerId} timeout fact archived`);
      } catch (err) {
        console.error(`[worker] ${workerId} failed to archive timeout fact:`, (err as Error).message);
      }
    }
    scheduleCleanup(registry, workerId, workerDir);
  }, timeoutMs);

  // Store handle so we can cancel it if the worker finishes first
  registry.update(workerId, { timeoutHandle });

  // Run the task — non-blocking (we don't await this at the call site)
  const taskPrompt =
    `Please complete the task described in the system prompt. ` +
    `Write your findings to result.md when done.`;

  try {
    await session.prompt(taskPrompt);

    // Check for model errors
    const lastAssistant = session.messages
      .filter((m) => m.role === "assistant")
      .pop() as Record<string, unknown> | undefined;

    if (lastAssistant?.stopReason === "error") {
      throw new Error(String(lastAssistant.errorMessage ?? "Model error"));
    }

    // Success path
    clearTimeout(timeoutHandle);
    registry.update(workerId, {
      status: "complete",
      completedAt: new Date(),
      error: null,
      timeoutHandle: null,
    });
    const entry = registry.get(workerId);
    writeStatusFile(workerDir, {
      worker_id: workerId,
      status: "complete",
      task,
      started_at: entry?.startedAt.toISOString() ?? new Date().toISOString(),
      completed_at: new Date().toISOString(),
      model: modelString,
      error: null,
      result_path: resultPath,
    });
    console.log(`[worker] ${workerId} complete`);

    const factContent = `Worker ${workerId} complete, results at ${resultPath}`;
    try {
      const embedding = await embed(factContent, modelsDir);
      memoryStore.addFact(factContent, "worker", embedding);
      console.log(`[worker] ${workerId} completion fact archived`);
    } catch (err) {
      console.error(`[worker] ${workerId} failed to archive completion fact:`, (err as Error).message);
    }
  } catch (error) {
    const errMsg = (error as Error).message;
    // Don't overwrite a timeout status that was set by the timeout handler
    const currentEntry = registry.get(workerId);
    if (currentEntry?.status === "timeout") {
      session.dispose();
      return;
    }

    clearTimeout(timeoutHandle);
    registry.update(workerId, {
      status: "failed",
      completedAt: new Date(),
      error: errMsg,
      timeoutHandle: null,
    });
    const entry = registry.get(workerId);
    writeStatusFile(workerDir, {
      worker_id: workerId,
      status: "failed",
      task,
      started_at: entry?.startedAt.toISOString() ?? new Date().toISOString(),
      completed_at: new Date().toISOString(),
      model: modelString,
      error: errMsg,
      result_path: resultPath,
    });
    console.error(`[worker] ${workerId} failed:`, errMsg);

    const factContent = `Worker ${workerId} failed: ${errMsg}`;
    try {
      const embedding = await embed(factContent, modelsDir);
      memoryStore.addFact(factContent, "worker", embedding);
      console.log(`[worker] ${workerId} failure fact archived`);
    } catch (err2) {
      console.error(`[worker] ${workerId} failed to archive failure fact:`, (err2 as Error).message);
    }
  } finally {
    session.dispose();
    scheduleCleanup(registry, workerId, workerDir);
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Schedule removal of the worker's registry entry after 24 hours.
 * The result files remain on disk; only the in-memory tracking is cleared.
 */
function scheduleCleanup(
  registry: WorkerRegistry,
  workerId: string,
  _workerDir: string,
): void {
  // Keep the entry for 24 hours so check_worker still works.
  setTimeout(() => {
    registry.remove(workerId);
    console.log(`[worker] ${workerId} removed from registry after 24h`);
  }, 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the dispatch_worker and check_worker tools.
 *
 * @param config          App config (for model, tools, data_dir).
 * @param memoryStore     The user's archival memory store (for completion signals).
 * @param registry        Shared worker registry for this user.
 * @param isWorkerSession When true, dispatch_worker rejects all calls (no nesting).
 */
export function createWorkerTools(
  config: Config,
  memoryStore: MemoryStore,
  registry: WorkerRegistry,
  isWorkerSession = false,
): AgentTool<any>[] {
  const dispatchTool: AgentTool<typeof dispatchWorkerSchema> = {
    name: "dispatch_worker",
    label: "dispatch_worker",
    description:
      "Dispatch a background worker to perform a long-running task (research, content gathering, etc.). " +
      "Returns immediately — the worker runs in the background. " +
      "After dispatching, create a projection with trigger_on_fact matching the worker completion fact " +
      "(e.g. 'worker <id> complete') so you are notified when results are ready. " +
      "Workers can use web_search and fetch_url. They write results to result.md. " +
      "Max 3 concurrent workers.",
    parameters: dispatchWorkerSchema,
    async execute(
      _toolCallId: string,
      { task, tools: requestedTools, model: modelOverride, timeout_seconds }: DispatchWorkerInput,
    ): Promise<AgentToolResult<unknown>> {
      // Hard block: no nesting
      if (isWorkerSession) {
        return toolError("Workers cannot dispatch other workers.");
      }

      // Concurrency limit
      if (registry.runningCount() >= MAX_CONCURRENT_WORKERS) {
        return toolError(
          `Maximum concurrent workers (${MAX_CONCURRENT_WORKERS}) already running. ` +
          `Use check_worker to see current workers, or wait for one to complete.`,
        );
      }

      // Validate requested tools
      const toolNames: AllowedTool[] = [];
      for (const t of requestedTools ?? ["web_search", "fetch_url"]) {
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

      const timeoutMs = timeout_seconds ? timeout_seconds * 1000 : DEFAULT_TIMEOUT_MS;
      const modelString = modelOverride ?? config.agent.model;
      const resultPath = path.join(workerDir, "result.md");

      // Register immediately so check_worker can find it
      registry.register({
        workerId,
        status: "running",
        task,
        resultPath,
        workerDir,
        startedAt: new Date(),
        error: null,
        model: modelString,
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
        model: modelString,
        error: null,
        result_path: resultPath,
      });

      console.log(`[worker] Dispatching ${workerId} (model: ${modelString}, tools: ${toolNames.join(", ")})`);

      // Spawn in background — intentionally not awaited
      spawnWorkerSession({
        config,
        workerId,
        workerDir,
        task,
        modelOverride,
        toolNames,
        memoryStore,
        registry,
        timeoutMs,
      }).catch((err: Error) => {
        console.error(`[worker] ${workerId} spawn failed:`, err.message);
        registry.update(workerId, {
          status: "failed",
          completedAt: new Date(),
          error: `Spawn failed: ${err.message}`,
        });
      });

      // Return immediately — worker is running in the background
      const relativeResultPath = path.relative(config.data_dir, resultPath);
      return toolSuccess({
        worker_id: workerId,
        status: "running",
        result_path: relativeResultPath,
        trigger_hint: `worker ${workerId} complete`,
        note:
          `Worker dispatched. Create a projection with trigger_on_fact: "worker ${workerId} complete" ` +
          `to be notified when results are ready. Results will be at: ${relativeResultPath}`,
      });
    },
  };

  const checkTool: AgentTool<typeof checkWorkerSchema> = {
    name: "check_worker",
    label: "check_worker",
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
            const relResult = path.relative(config.data_dir, data.result_path);
            const elapsed = data.completed_at
              ? Math.round((new Date(data.completed_at).getTime() - new Date(data.started_at).getTime()) / 60000)
              : null;
            return toolSuccess({
              worker_id: data.worker_id,
              status: data.status,
              elapsed_minutes: elapsed,
              result_path: relResult,
              error: data.error ?? undefined,
              note: "Status read from disk (worker no longer in active registry).",
            });
          } catch {
            // Fall through to not-found
          }
        }
        return toolError(`Worker not found: ${worker_id}`);
      }

      const elapsedMs = Date.now() - entry.startedAt.getTime();
      const elapsedMinutes = Math.round(elapsedMs / 60000);
      const relativeResultPath = path.relative(config.data_dir, entry.resultPath);

      return toolSuccess({
        worker_id: entry.workerId,
        status: entry.status,
        elapsed_minutes: elapsedMinutes,
        result_path: relativeResultPath,
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.status === "complete" ? { note: `Results available at ${relativeResultPath}` } : {}),
      });
    },
  };

  return [dispatchTool, checkTool];
}
