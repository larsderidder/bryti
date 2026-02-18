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
import type { AgentTool } from "@mariozechner/pi-agent-core";
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

/**
 * A loaded, persistent agent session for a single user.
 */
export interface UserSession {
  /** The underlying pi AgentSession. */
  session: AgentSession;
  /** User this session belongs to. */
  userId: string;
  /** Path to the session file on disk. */
  sessionFile: string;
  /** Clean up event listeners. Does NOT delete the session file. */
  dispose(): void;
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
 * source of truth for conversation context. The JSONL audit log remains, but
 * getRecent() is only used by the conversation_search tool now.
 */
function buildSystemPrompt(config: Config, coreMemory: string): string {
  const parts: string[] = [];

  parts.push(config.agent.system_prompt);

  if (coreMemory) {
    parts.push(`## Your Core Memory (always visible)\n${coreMemory}`);
  }

  parts.push(
    "You have access to tools for web search, fetching URLs, file management, and memory. Use them wisely to help the user.",
  );

  parts.push(
    "After each conversation, consider whether any new information about the user " +
      "(preferences, facts, recurring topics) should be added to or updated in your " +
      "core memory. Do this without telling the user unless they ask.",
  );

  return parts.join("\n\n");
}

/**
 * Return the session file path for a user.
 */
export function sessionFilePath(config: Config, userId: string): string {
  const sessionsDir = path.join(config.data_dir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  return path.join(sessionsDir, `${userId}.jsonl`);
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
    model = available.find((m) => m.provider === providerName || m.id.includes(modelId));
  }
  if (!model) {
    throw new Error(
      `Model not found: ${modelConfig}. Available: ${modelRegistry.getAvailable().map((m) => m.id).join(", ")}`,
    );
  }

  console.log(`Using model: ${model.id} (${model.provider})`);

  // Session manager: open existing file or create new
  const sessFile = sessionFilePath(config, userId);
  const sessionManager = fs.existsSync(sessFile)
    ? SessionManager.open(sessFile)
    : SessionManager.create(config.data_dir, path.join(config.data_dir, "sessions"));

  // Resource loader with system prompt (no history injection)
  const memory = coreMemory.read();
  const loader = new DefaultResourceLoader({
    cwd: config.data_dir,
    agentDir,
    settingsManager: SettingsManager.create(config.data_dir, agentDir),
    systemPromptOverride: () => buildSystemPrompt(config, memory),
  });
  await loader.reload();

  const settingsManager = SettingsManager.create(config.data_dir, agentDir);

  const { session } = await createAgentSession({
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
    userId,
    sessionFile: sessFile,
    dispose() {
      unsubscribe();
      session.dispose();
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
 * Event handler type for agent session events.
 */
export type AgentEventHandler = (event: AgentSessionEvent) => void;

// Re-export AgentSession type for callers that need it
export type { AgentSession };
