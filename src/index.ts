#!/usr/bin/env node
/**
 * Bryti entry point.
 *
 * Wires config, persistent pi sessions (one per user), channel bridges
 * (Telegram, WhatsApp), cron scheduler, and the message queue together.
 *
 * Startup: load config, ensure data dirs, warm up embedding model, start
 * bridges, start scheduler, begin processing messages.
 *
 * Each message: load (or reuse) the user's persistent session, run
 * transcript repair, prompt the model with fallback, persist the
 * response to the JSONL audit log.
 */

// Load .env if present (needed when running as an installed npm binary)
import { existsSync } from "node:fs";
try {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || (process.env.HOME + "/.config");
    const dataEnv = process.env.BRYTI_DATA_DIR
      ? process.env.BRYTI_DATA_DIR + "/.env"
      : xdg + "/bryti/.env";
    if (existsSync(dataEnv)) {
      process.loadEnvFile(dataEnv);
    }
  }
} catch { /* not present, fine */ }

import path from "node:path";
import { loadConfig, ensureDataDirs, applyIntegrationEnvVars } from "./config.js";
import {
  readAndClearRestartMarker,
  loadConfigWithRollback,
} from "./restart.js";
import { runWithSupervisor, type RunningApp } from "./supervisor.js";
import {
  processMessage,
  getBridge,
  type AppState,
} from "./process-message.js";
import { createCoreMemory } from "./memory/core-memory.js";
import { createHistoryManager } from "./history.js";
import { warmupEmbeddings, disposeEmbeddings } from "./memory/embeddings.js";
import { TelegramBridge } from "./channels/telegram.js";
import { WhatsAppBridge } from "./channels/whatsapp.js";
import { createScheduler } from "./scheduler.js";
import { MessageQueue } from "./message-queue.js";
import type { IncomingMessage, ChannelBridge } from "./channels/types.js";
import { createTrustStore } from "./trust/index.js";
import { createUsageTracker } from "./usage.js";
import { createAppLogger, installConsoleFileLogging } from "./logger.js";
import { recoverPendingCheckpoints } from "./crash-recovery.js";
import { startProactiveCompaction } from "./compaction/proactive.js";
import { createEventsWatcher } from "./events-watcher.js";
import { checkForUpdate } from "./update-check.js";
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { version: BRYTI_VERSION } = _require("../package.json") as { version: string };

// AppState, processMessage, getOrLoadSession, getBridge, triggerRestart
// are imported from ./process-message.ts




/**
 * Start one app instance.
 */
async function startApp(onRequestRestart?: () => void): Promise<RunningApp> {
  // ---------------------------------------------------------------------------
  // Infra setup: config, logging, embedding model
  // ---------------------------------------------------------------------------
  const { config, rolledBack, rollbackReason } = loadConfigWithRollback();
  applyIntegrationEnvVars(config);
  ensureDataDirs(config);
  installConsoleFileLogging(createAppLogger(config.data_dir));

  console.log(`Bryti starting: agent="${config.agent.name}" model="${config.agent.model}"`);
  console.log(`Data directory: ${config.data_dir}`);
  console.log(`Providers: ${config.models.providers.map((p) => p.name).join(", ")}`);
  console.log(`Config cron jobs: ${config.cron.length}`);

  // Fire-and-forget: never blocks startup.
  void checkForUpdate(BRYTI_VERSION, config.data_dir);

  // Pre-load embedding model (best-effort: keyword search still works without it)
  const modelsDir = path.join(config.data_dir, ".models");
  console.log("Loading embedding model (downloading on first run)...");
  await warmupEmbeddings(modelsDir);
  const { embeddingsAvailable } = await import("./memory/embeddings.js");
  if (embeddingsAvailable()) {
    console.log("Embedding model ready.");
  } else {
    console.log("Embeddings unavailable. Archival memory will use keyword search only.");
  }

  const coreMemory = createCoreMemory(config.data_dir);
  const historyManager = createHistoryManager(config.data_dir);
  const usageTracker = createUsageTracker(config.data_dir);
  const trustStore = createTrustStore(config.data_dir, config.trust.approved_tools);

  // ---------------------------------------------------------------------------
  // Bridge setup: Telegram, WhatsApp
  // ---------------------------------------------------------------------------
  const bridges: ChannelBridge[] = [];

  if (config.telegram.token) {
    if (config.telegram.allowed_users.length === 0) {
      console.warn("[telegram] WARNING: allowed_users is empty. No users will be able to interact with the bot. Add Telegram user IDs to config.");
    }
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

  // ---------------------------------------------------------------------------
  // State assembly
  // ---------------------------------------------------------------------------
  const state: AppState = {
    config,
    coreMemory,
    historyManager,
    usageTracker,
    sessions: new Map(),
    bridges,
    scheduler: null!,
    enqueue: null,
    trustStore,
    lastUserMessages: new Map(),
    recoveredSessions: new Set(),
    pendingSchedulerContext: new Map(),
    requestRestart: onRequestRestart ?? null,
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

  // ---------------------------------------------------------------------------
  // Queue / scheduler wiring
  // ---------------------------------------------------------------------------

  // Wire up the enqueue function so worker trigger callbacks can inject messages
  state.enqueue = (msg) => queue.enqueue(msg);

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

  // Start proactive compaction (idle + nightly)
  const compactionJobs = startProactiveCompaction(config, () => state.sessions);

  // Watch data/events/ for notifications from pi sessions and external scripts
  const eventsWatcher = createEventsWatcher(config, (msg) => queue.enqueue(msg));
  eventsWatcher.start();

  // ---------------------------------------------------------------------------
  // Startup notifications: crash recovery, restart marker, config rollback
  // ---------------------------------------------------------------------------

  // Recover any pending messages from a previous crash
  await recoverPendingCheckpoints(config, async (checkpoint, userId) => {
    const bridge = getBridge(state, checkpoint.platform);
    await bridge.sendMessage(
      checkpoint.channelId,
      "Sorry, I crashed while working on your last message. Could you resend it?",
    );
  });

  // If this startup was triggered by a restart request, notify the user.
  // If config.yml was rolled back due to a bad edit, include a warning.
  const restartResult = readAndClearRestartMarker(config.data_dir);
  if (restartResult) {
    const { marker } = restartResult;
    console.log(`[restart] Back online after restart requested by ${marker.userId}: ${marker.reason}`);
    const bridge = bridges.find((b) => b.platform === marker.platform) ?? bridges[0];

    if (rolledBack) {
      console.warn(`[config] Config was rolled back due to: ${rollbackReason}`);
      await bridge.sendMessage(
        marker.channelId,
        `Back online, but your config.yml change was invalid and has been rolled back.\n\nError: ${rollbackReason}\n\nThe previous working config is still active.`,
      );
    } else {
      // Send a synthetic message through the agent so it can verify the
      // restart worked and confirm to the user without waiting for input.
      const restartMsg: IncomingMessage = {
        channelId: marker.channelId,
        userId: marker.userId,
        platform: marker.platform as "telegram" | "whatsapp",
        text: `[System: you just restarted. Reason: "${marker.reason}". ` +
          `Verify the restart achieved its goal (check that new tools/extensions loaded, ` +
          `config changes took effect, etc.) and briefly confirm to the user.]`,
        raw: { type: "restart_verification" },
      };
      queue.enqueue(restartMsg);
    }
  } else if (rolledBack) {
    // Rare: a snapshot existed but there was no restart marker (e.g. previous crash).
    // Log a warning but don't notify — we don't know which channel to use.
    console.warn(`[config] Config rolled back from snapshot (no restart marker). Reason: ${rollbackReason}`);
  }

  console.log("Bryti ready!");

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      console.log("Shutting down...");
      state.scheduler.stop();
      eventsWatcher.stop();
      for (const job of compactionJobs) job.stop();
      await Promise.all(state.bridges.map((b) => b.stop()));
      for (const [userId, userSession] of state.sessions) {
        console.log(`Disposing session for user ${userId}`);
        userSession.dispose();
      }
      await disposeEmbeddings();
    },
  };
}

/**
 * Start the bryti server. Called from the CLI dispatcher or directly
 * when index.ts is the entry point.
 */
export async function startServer(): Promise<void> {
  await runWithSupervisor(startApp);
}

// When run directly (not imported by cli.ts), start immediately.
const isDirectEntry = process.argv[1]?.endsWith("index.js");
if (isDirectEntry) {
  startServer().catch((error) => {
    console.error("Supervisor fatal error:", error);
    process.exit(1);
  });
}
