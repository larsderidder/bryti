/**
 * Worker session spawner and lifecycle management.
 *
 * Extracted from tools.ts to reduce file size and separate concerns:
 * - tools.ts handles the tool definitions (public API)
 * - spawn.ts handles session creation and lifecycle
 */

import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Config } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import { embed } from "../memory/embeddings.js";
import { createBraveSearchTool, createWebSearchTool } from "../tools/web-search.js";
import { createFetchUrlTool } from "../tools/fetch-url.js";
import { createWorkerScopedTools } from "./scoped-tools.js";
import type { WorkerRegistry } from "./registry.js";
import type { ProjectionStore } from "../projection/store.js";
import { createModelInfra, resolveModel } from "../model-infra.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
    `## Steering`,
    ``,
    `After every 3 tool calls, check for a file called steering.md using read_file.`,
    `If the file exists, read it and immediately incorporate the guidance into your work.`,
    `The steering note may narrow your focus, redirect your research, or add new requirements.`,
    `Treat it as an authoritative update from the agent that dispatched you.`,
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

export interface WorkerStatusFile {
  worker_id: string;
  status: "running" | "complete" | "failed" | "timeout" | "cancelled";
  task: string;
  started_at: string;
  completed_at: string | null;
  model: string;
  error: string | null;
  result_path: string;
}

export function writeStatusFile(workerDir: string, data: WorkerStatusFile): void {
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
// Types
// ---------------------------------------------------------------------------

const ALLOWED_TOOLS = ["web_search", "fetch_url"] as const;
type AllowedTool = (typeof ALLOWED_TOOLS)[number];

/**
 * Callback invoked when a worker's completion fact triggers projections.
 * Injects an immediate message into the agent queue instead of waiting
 * for the 5-minute cron tick.
 */
export type WorkerTriggerCallback = (triggered: Array<{ id: string; summary: string }>) => void;

// ---------------------------------------------------------------------------
// Worker session spawner
// ---------------------------------------------------------------------------

export async function spawnWorkerSession(opts: {
  config: Config;
  workerId: string;
  workerDir: string;
  task: string;
  modelOverride: string | undefined;
  toolNames: AllowedTool[];
  memoryStore: MemoryStore;
  projectionStore?: ProjectionStore;
  registry: WorkerRegistry;
  timeoutMs: number;
  onTrigger?: WorkerTriggerCallback;
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
    onTrigger,
  } = opts;

  const { authStorage, modelRegistry, agentDir } = createModelInfra(config);
  const modelsDir = path.join(config.data_dir, ".models");
  const resultPath = path.join(workerDir, "result.md");

  // Resolve model. Workers default to the first fallback model (cheaper) rather
  // than the primary model. The primary might be Opus/Sonnet via OAuth; we don't
  // want workers burning those tokens on research tasks.
  const workerDefault = config.tools.workers.model
    ?? config.agent.fallback_models?.[0]
    ?? config.agent.model;
  const modelString = modelOverride ?? workerDefault;
  const model = resolveModel(modelString, modelRegistry);
  if (!model) {
    throw new Error(`Worker model not found: ${modelString}`);
  }

  // Build scoped tools: only the requested ones + scoped file tools (always)
  const workerTools: AgentTool<any>[] = [];

  if (toolNames.includes("web_search") && config.tools.web_search.enabled) {
    const ws = config.tools.web_search;
    if (ws.brave_api_key) {
      workerTools.push(createBraveSearchTool(ws.brave_api_key));
    } else if (ws.searxng_url) {
      workerTools.push(createWebSearchTool(ws.searxng_url));
    }
    // If neither is configured, web_search is silently omitted from worker tools.
  }
  if (toolNames.includes("fetch_url")) {
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

      // Check if this fact triggers any projections (e.g., "worker w-xxx complete").
      // If so, invoke the callback to notify the main agent immediately instead
      // of waiting for the 5-minute scheduler tick.
      if (onTrigger && opts.projectionStore) {
        try {
          const triggered = await opts.projectionStore.checkTriggers(
            factContent,
            (text) => embed(text, modelsDir),
          );
          if (triggered.length > 0) {
            console.log(`[worker] ${workerId} triggered ${triggered.length} projection(s)`);
            onTrigger(triggered);
          }
        } catch (triggerErr) {
          console.error(`[worker] ${workerId} trigger check failed:`, (triggerErr as Error).message);
        }
      }
    } catch (err) {
      console.error(`[worker] ${workerId} failed to archive completion fact:`, (err as Error).message);
    }
  } catch (error) {
    const errMsg = (error as Error).message;
    // Don't overwrite a terminal status set externally (timeout handler or
    // worker_interrupt). Both set their own status before aborting the session,
    // so the error thrown by abort() here would otherwise clobber it.
    const currentEntry = registry.get(workerId);
    if (currentEntry?.status === "timeout" || currentEntry?.status === "cancelled") {
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
 * Remove the worker's registry entry after 24 hours. Result files stay on
 * disk; only the in-memory tracking is cleared.
 */
export function scheduleCleanup(
  registry: WorkerRegistry,
  workerId: string,
  _workerDir: string,
): void {
  // Keep the entry for 24 hours so worker_check still works.
  setTimeout(() => {
    registry.remove(workerId);
    console.log(`[worker] ${workerId} removed from registry after 24h`);
  }, 24 * 60 * 60 * 1000);
}
