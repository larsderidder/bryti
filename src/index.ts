/**
 * Pibot entry point.
 *
 * Wires together:
 * - Config loading
 * - Pi agent session (SDK)
 * - Telegram bridge
 * - Cron scheduler
 *
 * Flow:
 * 1. Load config
 * 2. Ensure data directories exist
 * 3. Create pi agent session with custom tools + system prompt
 * 4. Start Telegram bridge
 * 5. Start cron scheduler
 * 6. Bridge incoming messages -> agent.prompt() -> bridge outgoing responses
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig, ensureDataDirs, type Config } from "./config.js";
import { createCoreMemory, type CoreMemory } from "./memory/core-memory.js";
import { createHistoryManager, type HistoryManager, type ChatMessage } from "./history.js";
import { warmupEmbeddings } from "./memory/embeddings.js";
import { createTools } from "./tools/index.js";
import { createAgentSessionFactory, type AgentSessionFactory } from "./agent.js";
import { TelegramBridge } from "./channels/telegram.js";
import { createCronScheduler, type CronScheduler } from "./cron.js";
import type { IncomingMessage, ChannelBridge } from "./channels/types.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

/**
 * Application state.
 */
interface AppState {
  config: Config;
  coreMemory: CoreMemory;
  historyManager: HistoryManager;
  agentFactory: AgentSessionFactory | null;
  bridge: ChannelBridge;
  cronScheduler: CronScheduler;
  isProcessing: boolean;
}

/**
 * Process an incoming message through the agent.
 */
async function processMessage(
  state: AppState,
  msg: IncomingMessage,
): Promise<void> {
  // Check if this is a special command
  if (msg.text === "/clear") {
    await state.historyManager.clear();
    await state.bridge.sendMessage(msg.channelId, "Conversation history cleared.");
    return;
  }

  if (msg.text === "/memory") {
    const memory = state.coreMemory.read();
    if (memory) {
      await state.bridge.sendMessage(
        msg.channelId,
        `Your core memory:\n\n${memory}`,
        { parseMode: "markdown" },
      );
    } else {
      await state.bridge.sendMessage(
        msg.channelId,
        "Your core memory is empty. I haven't saved anything yet.",
      );
    }
    return;
  }

  // Show typing indicator
  await state.bridge.sendTyping(msg.channelId);

  try {
    // Create a new session for each message (fresh context window)
    const { session, stop } = await createAgentSessionFactory(
      state.config,
      state.coreMemory,
      state.historyManager,
      createTools(state.config, state.coreMemory, msg.userId),
    );

    try {
      // Add user message to history
      await state.historyManager.append({
        role: "user",
        content: msg.text,
      });

      // Send to agent and wait for full response
      await session.prompt(msg.text);

      // Extract assistant response text
      const messages = session.messages;
      const lastAssistantMsg = messages.filter(
        (m) => m.role === "assistant",
      ).pop() as Record<string, unknown> | undefined;

      // Check for error responses from the model
      if (lastAssistantMsg?.stopReason === "error") {
        const errorMsg = String(lastAssistantMsg.errorMessage || "Unknown model error");
        console.error("Model error:", errorMsg);
        await state.bridge.sendMessage(msg.channelId, `Model error: ${errorMsg}`);
        return;
      }

      let responseText = "";
      if (lastAssistantMsg && "content" in lastAssistantMsg) {
        const content = lastAssistantMsg.content;
        if (Array.isArray(content)) {
          responseText = content
            .filter((c: Record<string, unknown>) => c.type === "text")
            .map((c: Record<string, unknown>) => String(c.text || ""))
            .join("");
        } else if (typeof content === "string") {
          responseText = content;
        }
      }

      // Save to history and send
      if (responseText.trim()) {
        await state.historyManager.append({
          role: "assistant",
          content: responseText,
        });
        await state.bridge.sendMessage(msg.channelId, responseText);
      } else {
        await state.bridge.sendMessage(msg.channelId, "Done (no text response).");
      }
    } finally {
      await stop();
    }
  } catch (error) {
    const err = error as Error;
    console.error("Error processing message:", err);
    await state.bridge.sendMessage(
      msg.channelId,
      `Error: ${err.message}`,
    );
  }
}

/**
 * Main function.
 */
async function main(): Promise<void> {
  // Load config
  const config = loadConfig();
  ensureDataDirs(config);

  console.log(`Pibot starting: agent="${config.agent.name}" model="${config.agent.model}"`);
  console.log(`Data directory: ${config.data_dir}`);
  console.log(`Providers: ${config.models.providers.map((p) => p.name).join(", ")}`);
  console.log(`Cron jobs: ${config.cron.length}`);

  // Pre-load embedding model to avoid latency on the first memory operation
  const modelsDir = path.join(config.data_dir, ".models");
  console.log("Loading embedding model (downloading on first run)...");
  await warmupEmbeddings(modelsDir);
  console.log("Embedding model ready.");

  // Create memory and history managers
  const coreMemory = createCoreMemory(config.data_dir);
  const historyManager = createHistoryManager(config.data_dir);

  // Create Telegram bridge
  const bridge = new TelegramBridge(config.telegram.token, config.telegram.allowed_users);

  // Track if we're currently processing a message
  const state: AppState = {
    config,
    coreMemory,
    historyManager,
    agentFactory: null,
    bridge,
    cronScheduler: null!,
    isProcessing: false,
  };

  // Handle incoming messages
  bridge.onMessage(async (msg: IncomingMessage) => {
    // If already processing, tell the user instead of silently dropping
    if (state.isProcessing) {
      console.log("Busy, notifying user:", msg.text);
      await bridge.sendMessage(msg.channelId, "Still processing your previous message, please wait...");
      return;
    }

    state.isProcessing = true;
    try {
      await processMessage(state, msg);
    } finally {
      state.isProcessing = false;
    }
  });

  // Start bridge
  await bridge.start();

  // Start cron scheduler
  const cronScheduler = createCronScheduler(config, async (msg: IncomingMessage) => {
    // For cron, use the first allowed user or the bot's own chat
    const channelId = config.telegram.allowed_users[0]
      ? String(config.telegram.allowed_users[0])
      : "cron";

    const cronMsg: IncomingMessage = {
      ...msg,
      channelId,
    };

    await processMessage(state, cronMsg);
  });
  cronScheduler.start();
  state.cronScheduler = cronScheduler;

  console.log("Pibot ready!");

  // Handle shutdown
  process.on("SIGINT", async () => {
    console.log("Shutting down...");
    state.cronScheduler.stop();
    await bridge.stop();
    if (state.agentFactory) {
      await state.agentFactory.stop();
    }
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
