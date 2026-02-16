/**
 * Agent session management.
 *
 * Wraps pi's SDK createAgentSession() with pibot-specific configuration:
 * - Custom tools (web search, fetch URL, files, memory)
 * - Custom system prompt (template + memory injection)
 * - Model configuration via models.json for open model providers
 * - No pi built-in tools (read/write/edit/bash); we provide our own sandboxed versions
 *
 * The pi SDK handles:
 * - Agent loop (prompt -> tool calls -> response)
 * - Model routing and API communication
 * - Session/message history (internal to pi)
 * - Streaming
 * - Auto-retry on failures
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
import type { HistoryManager, ChatMessage } from "./history.js";

/**
 * Agent session configuration.
 */
export interface AgentSessionFactory {
  /** The created session. */
  session: AgentSession;

  /** Stop the session and clean up. */
  stop(): Promise<void>;
}

/**
 * Generate models.json from pibot config.
 */
function generateModelsJson(config: Config, agentDir: string): void {
  const modelsJsonPath = path.join(agentDir, "models.json");

  const providers: Record<string, unknown> = {};

  for (const provider of config.models.providers) {
    // Skip groq since it's built-in
    if (provider.name === "groq") {
      continue;
    }

    providers[provider.name] = {
      baseUrl: provider.base_url,
      api: "openai-completions",
      apiKey: `${provider.name.toUpperCase()}_API_KEY`,
      models: provider.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.context_window || 131072,
        ...(m.max_tokens && { maxTokens: m.max_tokens }),
        ...(m.cost && { cost: m.cost }),
      })),
    };
  }

  const modelsJson = { providers };
  fs.writeFileSync(modelsJsonPath, JSON.stringify(modelsJson, null, 2), "utf-8");
  console.log(`Generated models.json at ${modelsJsonPath}`);
}

/**
 * Build the system prompt with memory and recent conversation history.
 */
function buildSystemPrompt(
  config: Config,
  coreMemory: string,
  history: ChatMessage[],
): string {
  const parts: string[] = [];

  // Main system prompt
  parts.push(config.agent.system_prompt);

  // Core memory section
  if (coreMemory) {
    parts.push(`## Your Core Memory (always visible)\n${coreMemory}`);
  }

  // Recent conversation section
  if (history.length > 0) {
    const conversationText = history
      .map((msg) => {
        if (msg.role === "user") {
          return `User: ${msg.content}`;
        } else if (msg.role === "assistant") {
          return `Assistant: ${msg.content}`;
        }
        return null;
      })
      .filter(Boolean)
      .join("\n\n");

    parts.push(`## Recent Conversation\n${conversationText}`);
  }

  // Tool instructions
  parts.push("You have access to tools for web search, fetching URLs, file management, and memory. Use them wisely to help the user.");

  return parts.join("\n\n");
}

/**
 * Create an agent session factory.
 */
export async function createAgentSessionFactory(
  config: Config,
  coreMemory: CoreMemory,
  historyManager: HistoryManager,
  customTools: AgentTool[],
  // Optional: pass pre-loaded history to avoid extra read
  // If not provided, will load from historyManager
  preloadedHistory?: ChatMessage[],
): Promise<AgentSessionFactory> {
  const agentDir = path.join(config.data_dir, ".pi");

  // Ensure .pi directory exists
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, "auth"), { recursive: true });

  // Generate models.json from config
  generateModelsJson(config, agentDir);

  // Set up auth storage with runtime API keys
  const authStorage = new AuthStorage(path.join(agentDir, "auth", "auth.json"));

  // Set API keys from config
  for (const provider of config.models.providers) {
    if (provider.api_key) {
      authStorage.setRuntimeApiKey(provider.name, provider.api_key);
    }
  }

  // Create model registry
  const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
  modelRegistry.refresh();

  // Resolve the configured model
  const modelConfig = config.agent.model;
  const [providerName, modelId] = modelConfig.includes("/")
    ? modelConfig.split("/")
    : [modelConfig, modelConfig];

  let model = modelRegistry.find(providerName, modelId);
  if (!model) {
    // Try to find any model from this provider
    const availableModels = modelRegistry.getAvailable();
    model = availableModels.find((m) => m.provider === providerName || m.id.includes(modelId));
  }
  if (!model) {
    throw new Error(
      `Model not found: ${modelConfig}. Available: ${modelRegistry.getAvailable().map((m) => m.id).join(", ")}`,
    );
  }

  console.log(`Using model: ${model.id} (${model.provider})`);

  // Load memory and history
  const memory = coreMemory.read();
  const history = preloadedHistory ?? await historyManager.getRecent(20, 4000);

  // Create resource loader with custom system prompt (includes memory and history)
  const loader = new DefaultResourceLoader({
    cwd: config.data_dir,
    agentDir,
    settingsManager: SettingsManager.create(config.data_dir, agentDir),
    systemPromptOverride: () => buildSystemPrompt(config, memory, history),
  });
  await loader.reload();

  // Create settings manager with retry enabled
  const settingsManager = SettingsManager.create(config.data_dir, agentDir);

  // Create the agent session
  const { session } = await createAgentSession({
    cwd: config.data_dir,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "off",
    tools: [], // No built-in tools - we provide our own
    customTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  return {
    session,

    async stop(): Promise<void> {
      session.dispose();
    },
  };
}

/**
 * Event handler for agent session events.
 */
export type AgentEventHandler = (event: AgentSessionEvent) => void;
