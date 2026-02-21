/**
 * Pibot entry point.
 *
 * Wires together:
 * - Config loading
 * - Pi agent sessions (persistent, one per user)
 * - Telegram bridge
 * - Cron scheduler
 * - Message queue (FIFO, per channel, with merge)
 *
 * Flow:
 * 1. Load config
 * 2. Ensure data directories exist
 * 3. Warm up embedding model
 * 4. Start Telegram bridge
 * 5. Start cron scheduler
 * 6. On message: load (or reuse) the user's persistent session, repair
 *    transcript, prompt, persist response to JSONL audit log
 */

import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import { loadConfig, ensureDataDirs, type Config } from "./config.js";
import { createCoreMemory, type CoreMemory } from "./memory/core-memory.js";
import { createHistoryManager, type HistoryManager } from "./history.js";
import { warmupEmbeddings } from "./memory/embeddings.js";
import { createTools } from "./tools/index.js";
import { loadUserSession, repairSessionTranscript, refreshSystemPrompt, promptWithFallback, SILENT_REPLY_TOKEN, type UserSession } from "./agent.js";
import { TelegramBridge } from "./channels/telegram.js";
import { WhatsAppBridge } from "./channels/whatsapp.js";
import { createScheduler, type Scheduler } from "./scheduler.js";
import { MessageQueue } from "./message-queue.js";
import type { IncomingMessage, ChannelBridge } from "./channels/types.js";
import {
  calculateCostUsd,
  createUsageTracker,
  resolveModelCost,
  type UsageTracker,
} from "./usage.js";
import { createAppLogger, installConsoleFileLogging } from "./logger.js";
import { getUserTimezone } from "./time.js";

/**
 * Application state.
 */
interface AppState {
  config: Config;
  coreMemory: CoreMemory;
  historyManager: HistoryManager;
  usageTracker: UsageTracker;
  /** Persistent session cache: one session per userId. */
  sessions: Map<string, UserSession>;
  /** Active channel bridges (Telegram, WhatsApp, etc.) */
  bridges: ChannelBridge[];
  scheduler: Scheduler;
}

interface AssistantMessageLike {
  role: "assistant";
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cost?: {
      total?: number;
    };
  };
}

interface RunningApp {
  stop(): Promise<void>;
}

function toAssistantMessage(message: unknown): AssistantMessageLike | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const candidate = message as { role?: unknown };
  if (candidate.role !== "assistant") {
    return undefined;
  }
  return message as AssistantMessageLike;
}

function modelNameForLog(
  provider: string | undefined,
  model: string | undefined,
  fallback: string,
): string {
  if (provider && model) {
    return `${provider}/${model}`;
  }
  return model || fallback;
}

/**
 * Find the bridge that handles a given platform (or the first available bridge
 * as fallback for scheduler-injected messages).
 */
function getBridge(state: AppState, platform?: string): ChannelBridge {
  if (platform) {
    const match = state.bridges.find((b) => b.platform === platform);
    if (match) return match;
  }
  return state.bridges[0];
}

/**
 * Get or load the persistent session for a user.
 */
async function getOrLoadSession(state: AppState, userId: string): Promise<UserSession> {
  const existing = state.sessions.get(userId);
  if (existing) {
    return existing;
  }

  const tools = createTools(state.config, state.coreMemory, userId);
  const userSession = await loadUserSession(
    state.config,
    state.coreMemory,
    userId,
    tools,
  );

  state.sessions.set(userId, userSession);
  return userSession;
}

/**
 * Process an incoming message through the agent.
 */
async function processMessage(
  state: AppState,
  msg: IncomingMessage,
): Promise<void> {
  // Special commands handled before touching the agent
  if (msg.text === "/clear") {
    // Clear the JSONL audit log and dispose the in-memory session so the next
    // message starts fresh (a new session file will be created).
    await state.historyManager.clear();
    const existing = state.sessions.get(msg.userId);
    if (existing) {
      existing.dispose();
      state.sessions.delete(msg.userId);
      // Delete the session directory so the next message creates a fresh session
      if (fs.existsSync(existing.sessionDir)) {
        fs.rmSync(existing.sessionDir, { recursive: true, force: true });
      }
    }
    await getBridge(state, msg.platform).sendMessage(msg.channelId, "Conversation history cleared.");
    return;
  }

  if (msg.text === "/memory") {
    const memory = state.coreMemory.read();
    if (memory) {
      await getBridge(state, msg.platform).sendMessage(msg.channelId, `Your core memory:\n\n${memory}`);
    } else {
      await getBridge(state, msg.platform).sendMessage(
        msg.channelId,
        "Your core memory is empty. I haven't saved anything yet.",
      );
    }
    return;
  }

  // Show typing indicator
  await getBridge(state, msg.platform).sendTyping(msg.channelId);

  try {
    // Load (or reuse) the persistent session for this user
    const userSession = await getOrLoadSession(state, msg.userId);
    const { session } = userSession;

    // Track last user message time (scheduler messages have raw.type set)
    const rawObj = msg.raw as Record<string, unknown> | null | undefined;
    const isSchedulerMessage = rawObj?.type != null;
    if (!isSchedulerMessage) {
      userSession.lastUserMessageAt = Date.now();
    }

    // Repair transcript before prompting
    repairSessionTranscript(session, msg.userId);

    // Reload the system prompt so the agent sees any core memory changes
    // it made during the previous turn (core_memory_append / core_memory_replace)
    await refreshSystemPrompt(session);

    // Append user message to audit log
    await state.historyManager.append({
      role: "user",
      content: msg.text,
    });

    // Prompt the agent, with automatic fallback to other models if the primary fails
    const promptStart = Date.now();
    await promptWithFallback(
      session,
      msg.text,
      state.config,
      userSession.modelRegistry,
      msg.userId,
    );
    const latencyMs = Date.now() - promptStart;

    // Extract the last assistant response
    const lastAssistant = toAssistantMessage(
      session.messages.filter((m) => m.role === "assistant").pop(),
    );

    const inputTokens = lastAssistant?.usage?.input ?? 0;
    const outputTokens = lastAssistant?.usage?.output ?? 0;
    const model = modelNameForLog(
      lastAssistant?.provider,
      lastAssistant?.model,
      state.config.agent.model,
    );
    const costConfig = resolveModelCost(
      state.config,
      lastAssistant?.provider,
      lastAssistant?.model ?? state.config.agent.model,
    );
    const costUsd = costConfig
      ? calculateCostUsd(inputTokens, outputTokens, costConfig)
      : (lastAssistant?.usage?.cost?.total ?? 0);

    await state.usageTracker.append({
      user_id: msg.userId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      latency_ms: latencyMs,
    });

    if (lastAssistant?.stopReason === "error") {
      const errorMsg = String(lastAssistant.errorMessage ?? "Unknown model error");
      console.error("Model error:", errorMsg);
      await getBridge(state, msg.platform).sendMessage(msg.channelId, `Model error: ${errorMsg}`);
      return;
    }

    let responseText = "";
    if (lastAssistant && "content" in lastAssistant) {
      const content = lastAssistant.content;
      if (Array.isArray(content)) {
        responseText = content
          .filter((c: Record<string, unknown>) => c.type === "text")
          .map((c: Record<string, unknown>) => String(c.text ?? ""))
          .join("");
      } else if (typeof content === "string") {
        responseText = content;
      }
    }

    if (responseText.trim() === SILENT_REPLY_TOKEN) {
      // Scheduled/proactive turn with nothing to surface — swallow silently
      console.log(`[agent] Silent reply from ${msg.userId}, suppressing message`);
    } else if (responseText.trim()) {
      // Append to audit log
      await state.historyManager.append({
        role: "assistant",
        content: responseText,
      });
      await getBridge(state, msg.platform).sendMessage(msg.channelId, responseText);
    } else {
      await getBridge(state, msg.platform).sendMessage(msg.channelId, "Done (no text response).");
    }
  } catch (error) {
    const err = error as Error;
    console.error("Error processing message:", err);
    await getBridge(state, msg.platform).sendMessage(msg.channelId, `Error: ${err.message}`);
  }
}

/**
 * Start one app instance.
 */
async function startApp(): Promise<RunningApp> {
  const config = loadConfig();
  ensureDataDirs(config);
  installConsoleFileLogging(createAppLogger(config.data_dir));

  console.log(`Pibot starting: agent="${config.agent.name}" model="${config.agent.model}"`);
  console.log(`Data directory: ${config.data_dir}`);
  console.log(`Providers: ${config.models.providers.map((p) => p.name).join(", ")}`);
  console.log(`Config cron jobs: ${config.cron.length}`);

  // Pre-load embedding model
  const modelsDir = path.join(config.data_dir, ".models");
  console.log("Loading embedding model (downloading on first run)...");
  await warmupEmbeddings(modelsDir);
  console.log("Embedding model ready.");

  const coreMemory = createCoreMemory(config.data_dir);
  const historyManager = createHistoryManager(config.data_dir);
  const usageTracker = createUsageTracker(config.data_dir);

  // Start channel bridges
  const bridges: ChannelBridge[] = [];

  if (config.telegram.token) {
    const telegram = new TelegramBridge(config.telegram.token, config.telegram.allowed_users);
    bridges.push(telegram);
  }

  if (config.whatsapp.enabled) {
    const whatsapp = new WhatsAppBridge(config.data_dir, config.whatsapp.allowed_users);
    bridges.push(whatsapp);
  }

  if (bridges.length === 0) {
    throw new Error("No channel bridges configured. Enable Telegram and/or WhatsApp.");
  }

  const state: AppState = {
    config,
    coreMemory,
    historyManager,
    usageTracker,
    sessions: new Map(),
    bridges,
    scheduler: null!,
  };

  const queue = new MessageQueue(
    (msg) => processMessage(state, msg),
    async (msg) => {
      console.log("Queue full, rejecting message:", msg.text);
      const bridge = getBridge(state, msg.platform);
      await bridge.sendMessage(
        msg.channelId,
        "I'm a bit overwhelmed right now. Please wait a moment and try again.",
      );
    },
  );

  for (const bridge of bridges) {
    bridge.onMessage(async (msg: IncomingMessage) => {
      queue.enqueue(msg);
    });
  }

  // Start all bridges concurrently
  await Promise.all(bridges.map((b) => b.start()));
  console.log(`Channels: ${bridges.map((b) => b.name).join(", ")}`);

  const scheduler = createScheduler(config, async (msg: IncomingMessage) => {
    queue.enqueue(msg);
  });
  scheduler.start();
  state.scheduler = scheduler;

  // -----------------------------------------------------------------------
  // Proactive compaction: idle and nightly
  //
  // Pi SDK auto-compacts when the context window fills, but that's the worst
  // time (mid-conversation, adds latency). Proactive compaction keeps context
  // lean during quiet periods.
  // -----------------------------------------------------------------------

  const IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
  const compactionJobs: Cron[] = [];

  /**
   * Try to compact a session. Skips if already compacting or if there are
   * very few messages (not worth compacting).
   */
  const IDLE_CONTEXT_THRESHOLD = 30; // percent of context window

  async function tryCompact(userSession: UserSession, reason: string): Promise<void> {
    const { session, userId } = userSession;
    if (session.isCompacting) return;

    // Don't compact tiny sessions (system + a couple messages)
    const messageCount = session.messages.length;
    if (messageCount < 6) return;

    // Idle compaction: only when context is above threshold. No point compacting
    // a mostly-empty context just because the user stepped away.
    // Nightly compaction always runs (fresh start for the morning).
    if (reason !== "nightly") {
      const usage = session.getContextUsage();
      const percent = usage?.percent ?? 0;
      if (percent < IDLE_CONTEXT_THRESHOLD) {
        return;
      }
    }

    console.log(`[compaction] proactive ${reason} for user ${userId} (${messageCount} messages)`);
    try {
      const reasonHint = reason === "nightly"
        ? "This is a nightly compaction. The user is asleep. " +
          "Summarize the entire day's conversation into a concise recap. " +
          "Tomorrow's session should start clean with full context of what happened today."
        : "The user has been inactive for a while and may return to continue. " +
          "Summarize completed topics but preserve the thread of any ongoing discussion.";

      await session.compact(
        `${reasonHint} ` +
        "This is a personal assistant conversation. " +
        "Preserve: user preferences, commitments and promises made, ongoing tasks, " +
        "facts learned about the user, decisions made, and any context the user would " +
        "expect the assistant to remember. " +
        "Discard: verbose tool outputs, raw search results, intermediate reasoning, " +
        "and conversational filler.",
      );
      console.log(`[compaction] proactive ${reason} done for user ${userId}`);
    } catch (err) {
      console.error(`[compaction] proactive ${reason} failed for user ${userId}:`, (err as Error).message);
    }
  }

  // Check every 10 minutes: compact sessions idle for 30+ minutes
  const idleCheck = new Cron("*/10 * * * *", { timezone: "UTC" }, () => {
    const now = Date.now();
    for (const [_userId, userSession] of state.sessions) {
      const idleMs = now - userSession.lastUserMessageAt;
      if (idleMs >= IDLE_THRESHOLD_MS) {
        tryCompact(userSession, "idle").catch(() => {});
      }
    }
  });
  compactionJobs.push(idleCheck);

  // Nightly compaction at 03:00 user timezone (all sessions)
  const tz = getUserTimezone(config);
  const nightlyCompact = new Cron("0 3 * * *", { timezone: tz }, () => {
    for (const [_userId, userSession] of state.sessions) {
      tryCompact(userSession, "nightly").catch(() => {});
    }
  });
  compactionJobs.push(nightlyCompact);

  console.log(`Proactive compaction: idle check every 10 min (threshold: 30 min), nightly at 03:00 ${tz}`);
  console.log("Pibot ready!");

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      console.log("Shutting down...");
      state.scheduler.stop();
      for (const job of compactionJobs) job.stop();
      await Promise.all(state.bridges.map((b) => b.stop()));
      for (const [userId, userSession] of state.sessions) {
        console.log(`Disposing session for user ${userId}`);
        userSession.dispose();
      }
    },
  };
}

function asError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(String(reason));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithSupervisor(): Promise<void> {
  const restartDelayMs = Number(process.env.PIBOT_RESTART_DELAY_MS ?? 2000);
  let shutdownRequested = false;
  let resolver: ((outcome: "shutdown" | "restart") => void) | null = null;

  const resolveOutcome = (outcome: "shutdown" | "restart"): void => {
    if (!resolver) {
      return;
    }
    const current = resolver;
    resolver = null;
    current(outcome);
  };

  const onSignal = (): void => {
    shutdownRequested = true;
    resolveOutcome("shutdown");
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  while (!shutdownRequested) {
    let app: RunningApp | undefined;
    let fatalError: Error | undefined;
    try {
      app = await startApp();
    } catch (error) {
      fatalError = asError(error);
    }

    if (!app) {
      console.error("Fatal startup error:", fatalError);
      if (shutdownRequested) {
        break;
      }
      console.log(`Restarting in ${restartDelayMs}ms...`);
      await sleep(restartDelayMs);
      continue;
    }

    const onUncaughtException = (error: Error): void => {
      fatalError = error;
      resolveOutcome("restart");
    };
    const onUnhandledRejection = (reason: unknown): void => {
      fatalError = asError(reason);
      resolveOutcome("restart");
    };

    process.once("uncaughtException", onUncaughtException);
    process.once("unhandledRejection", onUnhandledRejection);

    const outcome = await new Promise<"shutdown" | "restart">((resolve) => {
      if (shutdownRequested) {
        resolve("shutdown");
        return;
      }
      resolver = resolve;
    });

    process.removeListener("uncaughtException", onUncaughtException);
    process.removeListener("unhandledRejection", onUnhandledRejection);

    await app.stop();

    if (outcome === "shutdown") {
      break;
    }

    console.error("Fatal runtime error:", fatalError);
    if (shutdownRequested) {
      break;
    }
    console.log(`Restarting in ${restartDelayMs}ms...`);
    await sleep(restartDelayMs);
  }

  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}

runWithSupervisor().catch((error) => {
  console.error("Supervisor fatal error:", error);
  process.exit(1);
});
