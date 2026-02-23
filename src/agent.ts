/**
 * Agent session management.
 *
 * Wraps pi's createAgentSession() with bryti-specific config: persistent
 * per-user sessions, transcript repair before every prompt, core memory
 * injection into the system prompt, and custom tools.
 *
 * The pi SDK handles the agent loop, model routing, session persistence
 * (append-only JSONL), auto-compaction, streaming, and retry logic.
 *
 * Sessions persist across messages in data/sessions/<userId>/. The model
 * sees its actual prior tool calls and results in context; JSONL history
 * files are kept as an audit log for conversation search.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { Config } from "./config.js";
import type { CoreMemory } from "./memory/core-memory.js";
import { repairToolUseResultPairing } from "./compaction/transcript-repair.js";
import { createProjectionStore, formatProjectionsForPrompt } from "./projection/index.js";
import { registerToolCapabilities, getToolCapabilities } from "./trust/index.js";
import { createModelInfra, resolveModel } from "./model-infra.js";
import { buildSystemPrompt, buildToolSection, SILENT_REPLY_TOKEN, type ToolSummary } from "./system-prompt.js";

// Re-export for backward compatibility with index.ts
export { SILENT_REPLY_TOKEN };

/**
 * A loaded, persistent agent session for a single user.
 */
export interface UserSession {
  /** The underlying pi AgentSession. */
  session: AgentSession;
  /** Model registry, used by promptWithFallback() to resolve fallback models. */
  modelRegistry: ModelRegistry;
  /** User this session belongs to. */
  userId: string;
  /** Path to the per-user session directory on disk. */
  sessionDir: string;
  /** Timestamp of last user-initiated message (not scheduler). */
  lastUserMessageAt: number;
  /** Clean up event listeners. Does NOT delete the session file. */
  dispose(): void;
}



/**
 * Short human-readable summary of tool arguments for the audit log.
 * Gives the /log command enough context without storing raw LLM args.
 *
 * This output is for human audit trail consumption only (/log command).
 * It is never fed back to the model — it exists solely so operators can
 * read what the agent did without wading through raw JSON blobs.
 */
function buildArgsSummary(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  const a = args as Record<string, unknown>;

  switch (toolName) {
    case "memory_archival_search":
      return String(a.query ?? "");
    case "memory_archival_insert":
      return truncate(String(a.content ?? ""), 80);
    case "memory_core_append":
      return `${a.section}: ${truncate(String(a.content ?? ""), 60)}`;
    case "memory_core_replace":
      return String(a.section ?? "");
    case "memory_conversation_search":
      return String(a.query ?? "");
    case "projection_create":
      return truncate(String(a.summary ?? ""), 80);
    case "projection_resolve":
      return String(a.id ?? "");
    case "projection_list":
      return "";
    case "projection_link":
      return String(a.projection_id ?? "");
    case "worker_dispatch":
      return truncate(String(a.task ?? ""), 80);
    case "worker_check":
      return String(a.worker_id ?? "");
    case "worker_interrupt":
      return String(a.worker_id ?? "");
    case "worker_steer":
      return String(a.worker_id ?? "");
    case "file_read":
      return String(a.path ?? "");
    case "file_write":
      return String(a.path ?? "");
    case "file_list":
      return String(a.directory ?? "");
    default:
      return "";
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/**
 * Per-user session directory. Each user gets their own so continueRecent()
 * picks up the right session.
 */
function userSessionDir(config: Config, userId: string): string {
  const dir = path.join(config.data_dir, "sessions", userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Load (or create) a persistent agent session for a user.
 *
 * Opens an existing session file and loads its history, or creates a new
 * one if none exists. Transcript repair runs on load to fix any corrupted
 * tool-call/result pairings from a previous run.
 *
 * Call dispose() to clean up event listeners. The session file itself
 * survives; it's reused on the next message.
 */
export async function loadUserSession(
  config: Config,
  coreMemory: CoreMemory,
  userId: string,
  customTools: AgentTool[],
): Promise<UserSession> {
  const { authStorage, modelRegistry, agentDir } = createModelInfra(config);

  // --- 1. Model resolution ---
  // Resolve the configured model string to a registry entry. Throws if the
  // model is unknown so we fail fast before touching the session file.
  const model = resolveModel(config.agent.model, modelRegistry);
  if (!model) {
    throw new Error(
      `Model not found: ${config.agent.model}. Available: ${modelRegistry.getAvailable().map((m) => m.id).join(", ")}`,
    );
  }

  console.log(`Using model: ${model.id} (${model.provider})`);

  // Session manager: continue most recent session for this user, or create new.
  // Each user gets their own session directory so continueRecent finds the right file.
  const sessDir = userSessionDir(config, userId);
  const sessionManager = SessionManager.continueRecent(config.data_dir, sessDir);
  const promptTools: ToolSummary[] = customTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
  }));
  const extensionToolNames = new Set<string>();

  // --- 2. Resource loader setup with system prompt override closure ---
  // The override closure captures core memory and the projection store so it
  // can read both at call time. session.reload() triggers the closure, which
  // means every prompt sees up-to-date memory and projections without restarting.
  //
  // Bryti has its own skills directory in the data dir, separate from the global
  // pi CLI skills. Skills are curated for bryti independently of the CLI.

  // Projection store for this user. Opened once per session, closed on dispose.
  const projectionStore = createProjectionStore(userId, config.data_dir);

  const brytiSkillsDir = path.join(config.data_dir, "skills");
  const additionalSkillPaths = fs.existsSync(brytiSkillsDir) ? [brytiSkillsDir] : [];

  const loader = new DefaultResourceLoader({
    cwd: config.data_dir,
    agentDir,
    additionalSkillPaths,
    settingsManager: SettingsManager.create(config.data_dir, agentDir),
    systemPromptOverride: () => {
      // Expire projections older than 24 hours before injecting them into the
      // system prompt. Stale projections must be cleared first so the agent
      // never reasons about items that have clearly passed — seeing expired
      // events would cause it to act on outdated information.
      projectionStore.autoExpire(24);
      const upcoming = projectionStore.getUpcoming(7);
      const projectionText = formatProjectionsForPrompt(upcoming);
      return buildSystemPrompt(
        config,
        coreMemory.read(),
        promptTools,
        extensionToolNames,
        projectionText,
      );
    },
  });
  await loader.reload();

  const settingsManager = SettingsManager.create(config.data_dir, agentDir);

  // --- 3. Session creation + extension loading ---
  const { session, extensionsResult } = await createAgentSession({
    cwd: config.data_dir,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "off",
    tools: [],
    customTools,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
  });
  // Log extension loading results
  if (extensionsResult.extensions.length > 0) {
    for (const extension of extensionsResult.extensions) {
      const toolNames = [...extension.tools.keys()];
      console.log(`[extensions] Loaded: ${extension.path} (tools: ${toolNames.join(", ") || "none"})`);
      for (const toolName of toolNames) {
        extensionToolNames.add(toolName);
        // Register extension tools as elevated by default (they can do anything).
        // Skip if already registered with specific capabilities (e.g., shell_exec).
        const existing = getToolCapabilities(toolName);
        if (existing.level === "safe") {
          registerToolCapabilities(toolName, {
            level: "elevated",
            capabilities: ["network", "filesystem", "shell"],
            reason: "Extension tool with unrestricted access.",
          });
        }
      }
    }
    console.log(`[extensions] ${extensionsResult.extensions.length} extension(s) loaded, ${extensionToolNames.size} tool(s) registered`);
  }
  if (extensionsResult.errors.length > 0) {
    for (const err of extensionsResult.errors) {
      console.error(`[extensions] Failed to load ${err.path}: ${err.error}`);
    }
  }
  // --- 4. Tool registration ---
  // Rebuild promptTools from the fully resolved tool list (custom tools +
  // extension tools) so the system prompt lists every tool the model can call.
  promptTools.splice(
    0,
    promptTools.length,
    ...session.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  );
  await session.reload();

  // --- 5. Transcript repair on load ---
  // Fix any tool-call/result pairing issues that could have been written into
  // the session file from a previous run (partial writes, races, crashes).
  const currentMessages = session.messages;
  if (currentMessages.length > 0) {
    const report = repairToolUseResultPairing(currentMessages);
    if (report.changed) {
      session.agent.replaceMessages(report.messages);
      console.log(
        `Transcript repair on load for user ${userId}: ` +
        `added=${report.added.length} ` +
        `droppedDuplicates=${report.droppedDuplicateCount} ` +
        `droppedOrphans=${report.droppedOrphanCount}`,
      );
    }
  }

  // --- 6. Event subscription setup ---
  // Subscribe to session events for compaction telemetry and the tool-call
  // audit log. The unsubscribe handle is returned via dispose() so callers
  // can clean up without touching the session file.
  const logsDir = path.join(config.data_dir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const toolCallLogPath = path.join(logsDir, "tool-calls.jsonl");

  // Log compaction and tool call events
  const toolCallCounts = new Map<string, number>();
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "auto_compaction_start") {
      console.log(`[compaction] starting (reason: ${event.reason}) for user ${userId}`);
    } else if (event.type === "auto_compaction_end") {
      if (event.result) {
        const summary = event.result.summary;
        console.log(
          `[compaction] done for user ${userId}: ` +
          `tokensBefore=${event.result.tokensBefore} ` +
          `summaryLength=${summary.length}`,
        );
      } else if (event.errorMessage) {
        console.error(`[compaction] failed for user ${userId}: ${event.errorMessage}`);
      }
    } else if (event.type === "tool_execution_start") {
      const name = event.toolName ?? "unknown";
      toolCallCounts.set(name, (toolCallCounts.get(name) ?? 0) + 1);
      console.log(`[tool] ${name} called (total this session: ${toolCallCounts.get(name)})`);

      // Append a structured entry to the audit log. Best-effort: never crash the
      // subscriber if the write fails.
      try {
        const args = event.args;
        const argsSummary = buildArgsSummary(name, args);
        const entry = JSON.stringify({
          timestamp: new Date().toISOString(),
          userId,
          toolName: name,
          args_summary: argsSummary,
        });
        fs.appendFileSync(toolCallLogPath, entry + "\n", "utf-8");
      } catch {
        // Best-effort — never let a log write crash the agent loop
      }
    }
  });

  return {
    session,
    modelRegistry,
    userId,
    sessionDir: sessDir,
    lastUserMessageAt: Date.now(),
    dispose() {
      unsubscribe();
      session.dispose();
      projectionStore.close();
    },
  };
}

/**
 * Run transcript repair on the session's messages before prompting.
 * Catches pairing issues from the previous turn (partial writes, races).
 */
export function repairSessionTranscript(session: AgentSession, userId: string): void {
  const messages = session.messages;
  if (messages.length === 0) {
    return;
  }

  const report = repairToolUseResultPairing(messages);
  if (report.changed) {
    session.agent.replaceMessages(report.messages);
    console.log(
      `Transcript repair pre-prompt for user ${userId}: ` +
      `added=${report.added.length} ` +
      `droppedDuplicates=${report.droppedDuplicateCount} ` +
      `droppedOrphans=${report.droppedOrphanCount}`,
    );
  }
}



/**
 * Result of a prompt attempt in the fallback chain.
 */
interface FallbackResult {
  /** The model string that ultimately succeeded. */
  modelUsed: string;
  /** Number of models tried before success (0 = primary succeeded). */
  fallbacksUsed: number;
}

/**
 * Detect whether pi gave up on a prompt.
 *
 * Two failure modes exist:
 *
 *   1. Thrown error — the SDK exhausted its retry budget and threw. This
 *      covers network failures, timeouts, and provider outages.
 *
 *   2. Last assistant message has stopReason "error" — the model returned a
 *      response the SDK classified as a hard failure (for example a
 *      content-filter block or an internal model error). No exception is
 *      thrown in this case; the bad message is simply appended to the transcript.
 *
 * Both cases mean "try the next model" in the fallback chain.
 */
function didPromptFail(
  session: AgentSession,
  thrownError: unknown,
): { failed: boolean; reason: string } {
  if (thrownError) {
    const msg = thrownError instanceof Error ? thrownError.message : String(thrownError);
    return { failed: true, reason: msg };
  }

  const lastAssistant = session.messages
    .filter((m: AgentMessage) => m.role === "assistant")
    .pop() as Record<string, unknown> | undefined;

  if (lastAssistant?.stopReason === "error") {
    return {
      failed: true,
      reason: String(lastAssistant.errorMessage ?? "model error"),
    };
  }

  return { failed: false, reason: "" };
}

/**
 * Send a prompt, trying the primary model first then each fallback in order.
 *
 * On failure the session's model is switched via setModel() so the persistent
 * session file stays intact. Throws the last error if all candidates fail.
 */
export async function promptWithFallback(
  session: AgentSession,
  text: string,
  config: Config,
  modelRegistry: ModelRegistry,
  userId: string,
  images?: Array<{ data: string; mimeType: string }>,
): Promise<FallbackResult> {
  const candidates = [config.agent.model, ...(config.agent.fallback_models ?? [])];
  let lastError: unknown;
  let lastReason = "";

  // Convert to SDK ImageContent format
  const imageContent = images?.map((img) => ({
    type: "image" as const,
    data: img.data,
    mimeType: img.mimeType,
  }));

  if (imageContent && imageContent.length > 0) {
    console.log(
      `[images] Sending ${imageContent.length} image(s) to model for user ${userId}: ` +
      imageContent.map((img) => `${img.mimeType} (${Math.round(img.data.length * 0.75 / 1024)}KB base64)`).join(", "),
    );
  }

  for (let i = 0; i < candidates.length; i++) {
    const modelString = candidates[i];

    // Switch the session to this model if it's not already using it
    if (i > 0) {
      const model = resolveModel(modelString, modelRegistry);
      if (!model) {
        console.warn(`Fallback model not found in registry, skipping: ${modelString}`);
        continue;
      }
      console.log(
        `[fallback] Switching to model ${modelString} for user ${userId} ` +
        `(previous error: ${lastReason})`,
      );
      await session.setModel(model);
    }

    let thrownError: unknown = null;
    try {
      await session.prompt(text, imageContent ? { images: imageContent } : undefined);
    } catch (err) {
      thrownError = err;
    }

    const { failed, reason } = didPromptFail(session, thrownError);

    if (!failed) {
      if (i > 0) {
        console.log(`[fallback] Succeeded with model ${modelString} for user ${userId}`);
      }
      return { modelUsed: modelString, fallbacksUsed: i };
    }

    lastError = thrownError ?? new Error(reason);
    lastReason = reason;
    console.warn(
      `[fallback] Model ${modelString} failed for user ${userId}: ${reason}` +
      (i < candidates.length - 1 ? ", trying next..." : ", all models exhausted"),
    );
  }

  throw lastError ?? new Error("All models in fallback chain failed");
}

/**
 * Reload the system prompt so it picks up any core memory or projection
 * changes the agent made during the previous turn.
 *
 * TODO: session.reload() reloads the full resource set, which includes any
 * skill files on disk. If skill loading becomes slow (many/large skill files),
 * consider caching the parsed skill content and only re-reading core memory
 * and projections on each turn.
 */
export async function refreshSystemPrompt(session: AgentSession): Promise<void> {
  await session.reload();
}

// Re-export AgentSession type for callers that need it
export type { AgentSession };
