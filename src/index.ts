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
import { createMemoryManager, type MemoryManager } from "./memory.js";
import { createHistoryManager, type HistoryManager, type ChatMessage } from "./history.js";
import { createTools } from "./tools/index.js";
import { createAgentSessionFactory, type AgentSessionFactory } from "./agent.js";
import { TelegramBridge } from "./channels/telegram.js";
import { createCronScheduler, type CronScheduler } from "./cron.js";
import type { IncomingMessage, ChannelBridge } from "./channels/types.js";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";

/**
 * Application state.
 */
interface AppState {
  config: Config;
  memoryManager: MemoryManager;
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
    const memory = await state.memoryManager.read();
    if (memory) {
      await state.bridge.sendMessage(
        msg.channelId,
        `Your persistent memory:\n\n${memory}`,
        { parseMode: "markdown" },
      );
    } else {
      await state.bridge.sendMessage(
        msg.channelId,
        "Your memory is empty. I haven't saved anything yet.",
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
      state.memoryManager,
      state.historyManager,
      createTools(state.config, state.memoryManager),
    );

    // Track streaming state
    let currentMessageId: string | null = null;
    let currentText = "";

    // Subscribe to events for streaming
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        currentText += delta;

        // Debounce edits - send initial message, then edit
        if (!currentMessageId) {
          // First chunk - send message
          state.bridge.sendMessage(msg.channelId, currentText, { parseMode: "markdown" }).then((id) => {
            currentMessageId = id;
          });
        } else {
          // Subsequent chunks - edit message (debounced by caller)
          state.bridge.editMessage(msg.channelId, currentMessageId, currentText).catch(() => {
            // Ignore edit errors (may be rate limited)
          });
        }
      }
    });

    try {
      // Add user message to history
      await state.historyManager.append({
        role: "user",
        content: msg.text,
      });

      // Send to agent
      await session.prompt(msg.text);

      // Save assistant response to history
      const messages = session.messages;
      const lastAssistantMsg = messages.filter(
        (m) => m.role === "assistant" && "content" in m && m.content,
      ).pop();

      if (lastAssistantMsg && "content" in lastAssistantMsg) {
        const content = Array.isArray(lastAssistantMsg.content)
          ? lastAssistantMsg.content.map((c) => {
              const c2 = c as { text?: string };
              return c2.text || "";
            }).join("")
          : lastAssistantMsg.content;

        await state.historyManager.append({
          role: "assistant",
          content: typeof content === "string" ? content : "",
        });
      }

      // Send final response if not already sent
      if (!currentMessageId && currentText) {
        await state.bridge.sendMessage(msg.channelId, currentText, { parseMode: "markdown" });
      } else if (currentMessageId) {
        // Update with final text
        await state.bridge.editMessage(msg.channelId, currentMessageId, currentText);
      } else {
        // No text delta events - just send a completion message
        await state.bridge.sendMessage(
          msg.channelId,
          "Task completed.",
        );
      }
    } finally {
      unsubscribe();
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

  // Create memory and history managers
  const memoryManager = createMemoryManager(config.data_dir);
  const historyManager = createHistoryManager(config.data_dir);

  // Create Telegram bridge
  const bridge = new TelegramBridge(config.telegram.token, config.telegram.allowed_users);

  // Track if we're currently processing a message
  const state: AppState = {
    config,
    memoryManager,
    historyManager,
    agentFactory: null,
    bridge,
    cronScheduler: null!,
    isProcessing: false,
  };

  // Handle incoming messages
  bridge.onMessage(async (msg: IncomingMessage) => {
    // If already processing, queue or skip (v1: just skip)
    if (state.isProcessing) {
      console.log("Skipping message - already processing");
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
