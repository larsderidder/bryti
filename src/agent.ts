/**
 * Agent session management.
 *
 * Wraps pi's SDK createAgentSession() with pibot-specific configuration:
 * - Persistent sessions per user (session file survives across messages)
 * - Transcript repair before every prompt (fixes tool-call/result pairing)
 * - Auto-compaction via pi SDK (triggers automatically when context fills)
 * - Core memory always injected into system prompt
 * - Custom tools (web search, fetch URL, files, memory)
 *
 * The pi SDK handles:
 * - Agent loop (prompt -> tool calls -> response)
 * - Model routing and API communication
 * - Session persistence (append-only JSONL)
 * - Auto-compaction (summarises old turns when context fills)
 * - Streaming and auto-retry
 *
 * Architecture change from v0 (fresh-session-per-message):
 * - Sessions now persist across messages in data/sessions/<userId>.jsonl
 * - History is no longer injected into the system prompt as text
 * - The model sees its actual prior tool calls and results in context
 * - JSONL history files remain as an audit log for conversation_search
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  AuthStorage,
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
  /** Clean up event listeners. Does NOT delete the session file. */
  dispose(): void;
}

interface ToolSummary {
  name: string;
  description?: string;
}

/**
 * Generate models.json from pibot config.
 */
function generateModelsJson(config: Config, agentDir: string): void {
  const modelsJsonPath = path.join(agentDir, "models.json");

  const providers: Record<string, unknown> = {};

  for (const provider of config.models.providers) {
    if (provider.name === "groq") {
      continue;
    }

    providers[provider.name] = {
      baseUrl: provider.base_url,
      api: provider.api || "openai-completions",
      apiKey: provider.api_key,
      models: provider.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.context_window || 131072,
        ...(m.api && { api: m.api }),
        ...(m.max_tokens && { maxTokens: m.max_tokens }),
        ...(m.cost && { cost: m.cost }),
        ...(m.compat && { compat: m.compat }),
      })),
    };
  }

  fs.writeFileSync(
    modelsJsonPath,
    JSON.stringify({ providers }, null, 2),
    "utf-8",
  );
}

/**
 * Build the system prompt with core memory.
 *
 * History is no longer injected here. The persistent pi session file is the
 * source of truth for conversation context. The JSONL audit log remains for
 * conversation_search, which reads the files directly.
 */
export function buildToolSection(
  tools: ToolSummary[],
  extensionToolNames: Set<string>,
): string {
  if (tools.length === 0) {
    return "## Your currently loaded tools\n- None";
  }

  const lines = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const description = (tool.description ?? "No description provided.")
        .replace(/\s+/g, " ")
        .trim();
      const sourceSuffix = extensionToolNames.has(tool.name) ? " (extension)" : "";
      return `- ${tool.name}: ${description}${sourceSuffix}`;
    });

  return `## Your currently loaded tools\n${lines.join("\n")}`;
}

function buildSystemPrompt(
  config: Config,
  coreMemory: string,
  tools: ToolSummary[],
  extensionToolNames: Set<string>,
  projections: string,
): string {
  const parts: string[] = [];

  parts.push(config.agent.system_prompt);
  parts.push(buildToolSection(tools, extensionToolNames));

  if (coreMemory) {
    parts.push(`## Your Core Memory (always visible)\n${coreMemory}`);
  }

  parts.push(
    `## Your Projections (upcoming events and commitments)\n` +
    `These are things you expect to happen or that the user mentioned about the future.\n` +
    `Connect new information to these when relevant. Proactively help with upcoming events.\n\n` +
    projections,
  );

  return parts.join("\n\n");
}

/**
 * Return the per-user session directory. Each user gets their own directory
 * so that SessionManager.continueRecent() picks up the right session.
 */
export function userSessionDir(config: Config, userId: string): string {
  const dir = path.join(config.data_dir, "sessions", userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Load (or create) a persistent agent session for a user.
 *
 * If the session file already exists, it is opened and its history is loaded
 * into the agent. Transcript repair runs on every load to guard against
 * corrupted tool-call/result pairings that would cause API errors.
 *
 * Call dispose() to clean up event listeners when shutting down. The session
 * file is NOT deleted on dispose; it survives for the next message.
 */
export async function loadUserSession(
  config: Config,
  coreMemory: CoreMemory,
  userId: string,
  customTools: AgentTool[],
): Promise<UserSession> {
  const agentDir = path.join(config.data_dir, ".pi");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, "auth"), { recursive: true });

  generateModelsJson(config, agentDir);

  // Auth
  const authStorage = new AuthStorage(path.join(agentDir, "auth", "auth.json"));
  for (const provider of config.models.providers) {
    if (provider.api_key) {
      authStorage.setRuntimeApiKey(provider.name, provider.api_key);
    }
  }

  // Model registry
  const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
  modelRegistry.refresh();

  // Resolve model
  const modelConfig = config.agent.model;
  const [providerName, modelId] = modelConfig.includes("/")
    ? modelConfig.split("/")
    : [modelConfig, modelConfig];

  let model = modelRegistry.find(providerName, modelId);
  if (!model) {
    const available = modelRegistry.getAvailable();
    model = available.find(
      (m) => m.provider === providerName && m.id.includes(modelId),
    );
  }
  if (!model) {
    throw new Error(
      `Model not found: ${modelConfig}. Available: ${modelRegistry.getAvailable().map((m) => m.id).join(", ")}`,
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

  // Projection store for this user. Opened once per session, closed on dispose.
  const projectionStore = createProjectionStore(userId, config.data_dir);

  // Resource loader with system prompt (no history injection).
  // The override closure reads core memory and projections at call time so that
  // session.reload() picks up any changes made by the agent during the conversation.
  const loader = new DefaultResourceLoader({
    cwd: config.data_dir,
    agentDir,
    settingsManager: SettingsManager.create(config.data_dir, agentDir),
    systemPromptOverride: () => {
      // Auto-expire stale projections before injecting so the agent never
      // sees items whose time has clearly passed (24+ hours ago).
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
      }
    }
    console.log(`[extensions] ${extensionsResult.extensions.length} extension(s) loaded, ${extensionToolNames.size} tool(s) registered`);
  }
  if (extensionsResult.errors.length > 0) {
    for (const err of extensionsResult.errors) {
      console.error(`[extensions] Failed to load ${err.path}: ${err.error}`);
    }
  }
  promptTools.splice(
    0,
    promptTools.length,
    ...session.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  );
  await session.reload();

  // Transcript repair on load: fix any tool-call/result pairing issues that
  // could have been written into the session file from a previous run.
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

  // Log compaction events
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
    }
  });

  return {
    session,
    modelRegistry,
    userId,
    sessionDir: sessDir,
    dispose() {
      unsubscribe();
      session.dispose();
      projectionStore.close();
    },
  };
}

/**
 * Run transcript repair on the session's current messages before prompting.
 *
 * Called immediately before each session.prompt() to catch any pairing issues
 * that arose during the previous turn (race conditions, partial writes, etc.).
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
 * Resolve a "provider/modelId" string against the model registry.
 * Returns null if the model is not found in the registry.
 */
export function resolveModel(
  modelString: string,
  modelRegistry: ModelRegistry,
): Model<any> | null {
  const [providerName, modelId] = modelString.includes("/")
    ? modelString.split("/")
    : [modelString, modelString];

  let model = modelRegistry.find(providerName, modelId);
  if (!model) {
    const available = modelRegistry.getAvailable();
    // Secondary lookup: same provider + model id substring match
    model = available.find(
      (m) => m.provider === providerName && m.id.includes(modelId),
    );
  }
  return model ?? null;
}

/**
 * Result of a prompt attempt in the fallback chain.
 */
export interface FallbackResult {
  /** The model string that ultimately succeeded. */
  modelUsed: string;
  /** Number of models tried before success (0 = primary succeeded). */
  fallbacksUsed: number;
}

/**
 * Detect whether pi gave up on a prompt.
 *
 * Two failure signals from pi:
 * - `session.prompt()` throws (network-level failure after all retries)
 * - Last assistant message has `stopReason === "error"` (model-level failure)
 *
 * We treat both as "try the next model."
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
 * On failure the session's model is switched via `session.setModel()` so the
 * persistent session file stays intact. If all candidates fail, the last error
 * is thrown.
 *
 * @param session   The user's persistent session
 * @param text      The prompt text
 * @param config    App config (for the fallback list)
 * @param modelRegistry  Registry used to resolve model strings to Model objects
 * @param userId    For logging
 */
export async function promptWithFallback(
  session: AgentSession,
  text: string,
  config: Config,
  modelRegistry: ModelRegistry,
  userId: string,
): Promise<FallbackResult> {
  const candidates = [config.agent.model, ...(config.agent.fallback_models ?? [])];
  let lastError: unknown;
  let lastReason = "";

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
      await session.prompt(text);
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
 * Reload the session's system prompt with the latest core memory content.
 *
 * The resource loader's systemPromptOverride closure reads coreMemory.read()
 * at call time, so session.reload() picks up any changes the agent made during
 * the previous turn (core_memory_append / core_memory_replace).
 *
 * Call this right before promptWithFallback() on every message.
 */
export async function refreshSystemPrompt(session: AgentSession): Promise<void> {
  await session.reload();
}

/**
 * Event handler type for agent session events.
 */
export type AgentEventHandler = (event: AgentSessionEvent) => void;

// Re-export AgentSession type for callers that need it
export type { AgentSession };
