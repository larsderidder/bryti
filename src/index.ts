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
try { process.loadEnvFile(".env"); } catch { /* not present, fine */ }

import fs from "node:fs";
import path from "node:path";
import type { Cron } from "croner";
import { loadConfig, ensureDataDirs, applyIntegrationEnvVars, type Config } from "./config.js";
import { createCoreMemory, type CoreMemory } from "./memory/core-memory.js";
import { createHistoryManager, type HistoryManager } from "./history.js";
import { warmupEmbeddings, disposeEmbeddings } from "./memory/embeddings.js";
import { createTools } from "./tools/index.js";
import { loadUserSession, repairSessionTranscript, refreshSystemPrompt, promptWithFallback, SILENT_REPLY_TOKEN, type UserSession } from "./agent.js";
import { TelegramBridge } from "./channels/telegram.js";
import { WhatsAppBridge } from "./channels/whatsapp.js";
import { createScheduler, type Scheduler } from "./scheduler.js";
import { MessageQueue } from "./message-queue.js";
import type { IncomingMessage, ChannelBridge } from "./channels/types.js";
import {
  createTrustStore,
  checkPendingApproval,
  isAlwaysApproval,
  type TrustStore,
  wrapToolsWithTrustChecks,
  type TrustWrapperContext,
} from "./trust/index.js";
import {
  calculateCostUsd,
  createUsageTracker,
  resolveModelCost,
  type UsageTracker,
} from "./usage.js";
import { createAppLogger, installConsoleFileLogging } from "./logger.js";
import { handleSlashCommand } from "./commands.js";
import {
  writePendingCheckpoint,
  deletePendingCheckpoint,
  recoverPendingCheckpoints,
} from "./crash-recovery.js";
import { startProactiveCompaction } from "./compaction/proactive.js";
import { checkForUpdate } from "./update-check.js";
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const { version: BRYTI_VERSION } = _require("../package.json") as { version: string };

// ---------------------------------------------------------------------------
// Restart protocol
//
// Exit code 42 tells run.sh this was intentional, so it loops immediately
// without delay. A marker file records who triggered the restart and which
// channel they're on, so the "Back online" message goes to the right place.
// ---------------------------------------------------------------------------

/**
 * Exit code that signals an intentional restart to the run.sh supervisor loop.
 * The loop checks for this code and restarts immediately without delay.
 */
export const RESTART_EXIT_CODE = 42;

interface RestartMarker {
  userId: string;
  channelId: string;
  platform: string;
  reason: string;
}

function restartMarkerPath(dataDir: string): string {
  return path.join(dataDir, "pending", "restart.json");
}

function writeRestartMarker(dataDir: string, marker: RestartMarker): void {
  fs.mkdirSync(path.join(dataDir, "pending"), { recursive: true });
  fs.writeFileSync(restartMarkerPath(dataDir), JSON.stringify(marker), "utf8");
}

interface RestartMarkerResult {
  marker: RestartMarker;
  /** True if config.yml was corrupted and auto-rolled back to the pre-restart snapshot. */
  configRolledBack: boolean;
  /** The parse/validation error message if a rollback occurred. */
  rollbackReason?: string;
}

function readAndClearRestartMarker(dataDir: string): RestartMarkerResult | null {
  const p = restartMarkerPath(dataDir);
  if (!fs.existsSync(p)) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(p, "utf8")) as RestartMarker;
    fs.rmSync(p, { force: true });
    return { marker, configRolledBack: false };
  } catch {
    fs.rmSync(p, { force: true });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config snapshot / rollback
//
// Before restarting with a potentially-modified config.yml, we snapshot the
// current (known-good) file. On the next startup, if loadConfig() fails, we
// restore the snapshot and retry so the process comes back up even after a
// bad config edit. On successful startup the snapshot is deleted.
// ---------------------------------------------------------------------------

function configSnapshotPath(dataDir: string): string {
  return path.join(dataDir, "pending", "config.yml.pre-restart");
}

/**
 * Snapshot the current config.yml before triggering a restart.
 * Called only when config.yml exists (successful boot confirms it was valid).
 */
function snapshotConfig(dataDir: string): void {
  const dataDir_ = path.resolve(process.env.BRYTI_DATA_DIR || "./data");
  // Use the resolved data dir from env, not the one stored in config (same value, but safer).
  const src = path.join(dataDir_, "config.yml");
  const dst = configSnapshotPath(dataDir_);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log("[config] Snapshotted config.yml for rollback if restart fails.");
  }
}

/**
 * On startup: if loadConfig() throws and a snapshot exists, restore it and
 * return the error that triggered the rollback. Otherwise rethrow.
 *
 * Returns the loaded config (from snapshot or original).
 * Throws only if loadConfig() fails AND no snapshot is available.
 */
function loadConfigWithRollback(): { config: ReturnType<typeof loadConfig>; rolledBack: boolean; rollbackReason?: string } {
  const dataDir = path.resolve(process.env.BRYTI_DATA_DIR || "./data");
  try {
    const config = loadConfig();
    // Success: delete any leftover snapshot (previous good restart).
    const snap = configSnapshotPath(dataDir);
    if (fs.existsSync(snap)) {
      fs.rmSync(snap, { force: true });
      console.log("[config] Deleted config snapshot (current config loaded successfully).");
    }
    return { config, rolledBack: false };
  } catch (err) {
    const snap = configSnapshotPath(dataDir);
    if (!fs.existsSync(snap)) {
      // No snapshot to fall back on — propagate the error.
      throw err;
    }

    const reason = (err as Error).message;
    console.warn(`[config] loadConfig() failed: ${reason}`);
    console.warn("[config] Restoring config.yml from pre-restart snapshot...");

    const cfgPath = path.join(dataDir, "config.yml");
    fs.copyFileSync(snap, cfgPath);
    fs.rmSync(snap, { force: true });

    // Retry with the restored config — if this also fails, propagate.
    const config = loadConfig();
    console.warn("[config] Rollback successful. Running on previous config.");
    return { config, rolledBack: true, rollbackReason: reason };
  }
}

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
  /**
   * Enqueue function for injecting messages into the processing queue.
   * Set after the queue is created (null during initial state assembly).
   * Used by worker trigger callbacks to notify the agent when a worker completes.
   */
  enqueue: ((msg: IncomingMessage) => void) | null;
  /** Trust store for runtime permission checks. */
  trustStore: TrustStore;
  /**
   * Last user-initiated message text per userId.
   * Passed to the LLM guardrail as context when evaluating elevated tool calls,
   * so the guardrail can judge whether the tool call matches what the user asked for.
   */
  lastUserMessages: Map<string, string>;
  /** Users whose session was recovered after corruption — notified on next message. */
  recoveredSessions: Set<string>;
  /**
   * Accumulated scheduler context per userId. When scheduler messages fire
   * (projections, reminders) without a user message to attach to, the text is
   * buffered here. On the next real user message, the buffer is prepended so
   * the agent can weave reminders into a single coherent response.
   */
  pendingSchedulerContext: Map<string, string[]>;
  /**
   * Restart context per userId. When bryti restarts, the reason is stored here
   * and injected into the next user message so the agent knows why it restarted
   * and can act on it (e.g. verify a new extension loaded, confirm a config change).
   */
  pendingRestartContext: Map<string, string>;
  /**
   * Signal the supervisor to restart the app. Set by runWithSupervisor(),
   * called by triggerRestart() instead of process.exit(42).
   */
  requestRestart: (() => void) | null;
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

/** Extract text content from an assistant message (ignores tool calls, thinking). */
function extractResponseText(msg: AssistantMessageLike | undefined): string {
  if (!msg || !("content" in msg)) return "";
  const content = msg.content;
  if (Array.isArray(content)) {
    return content
      .filter((c: Record<string, unknown>) => c.type === "text")
      .map((c: Record<string, unknown>) => String(c.text ?? ""))
      .join("");
  }
  if (typeof content === "string") return content;
  return "";
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
 * Find the bridge for a platform, falling back to the first available one.
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
async function getOrLoadSession(state: AppState, msg: IncomingMessage): Promise<UserSession> {
  const { userId, channelId, platform } = msg;
  const existing = state.sessions.get(userId);
  if (existing) {
    return existing;
  }

  const tools = createTools(state.config, state.coreMemory, userId, (triggered) => {
    // Worker completion triggered projections. Inject an immediate message
    // so the agent reads the results and notifies the user without waiting
    // for the 5-minute scheduler tick.
    //
    // The message text is deliberately explicit: the agent has no idea what the
    // worker found (it ran in isolation), and the user hasn't seen anything yet.
    // Without these instructions, the agent tends to assume the user is already
    // aware of the results and skips straight to next steps.
    if (!state.enqueue) return;
    const channelId = String(state.config.telegram.allowed_users[0] ?? userId);
    const summaries = triggered.map((p) => `- ${p.summary} (id: ${p.id})`).join("\n");
    state.enqueue({
      channelId,
      userId,
      text:
        `[Worker completed]\n\nThe following commitment(s) were triggered:\n\n${summaries}\n\n` +
        `IMPORTANT: The user has NOT seen the worker's results yet. You must:\n` +
        `1. Read the worker's result file (file_read)\n` +
        `2. Share the key findings with the user FIRST\n` +
        `3. Only THEN suggest next steps or act on them\n` +
        `Never assume the user knows what the worker found. Always present the findings before drawing conclusions or taking action.`,
      platform: "telegram",
      raw: { type: "worker_trigger" },
    });
  }, async (reason: string) => {
    // Agent-triggered restart. Signals supervisor to restart the app.
    await triggerRestart(state, { userId, channelId, platform, text: "", raw: null }, reason);
  });

  // Wrap tools with trust checks + LLM guardrail
  const trustContext: TrustWrapperContext = {
    config: state.config,
    getLastUserMessage: () => state.lastUserMessages.get(userId),
    onApprovalNeeded: async (prompt, approvalKey) => {
      const bridge = getBridge(state, platform);
      return bridge.sendApprovalRequest(channelId, prompt, approvalKey);
    },
  };
  const wrappedTools = wrapToolsWithTrustChecks(tools, state.trustStore, userId, trustContext);

  const sessDir = path.join(state.config.data_dir, "sessions", userId);

  let userSession: UserSession;
  try {
    userSession = await loadUserSession(state.config, state.coreMemory, userId, wrappedTools);
  } catch (err) {
    console.error(`[session] Failed to load session for user ${userId}, attempting recovery:`, err);
    const corruptDir = path.join(
      state.config.data_dir,
      "sessions",
      `${userId}-corrupt-${Date.now()}`,
    );
    if (fs.existsSync(sessDir)) {
      try {
        fs.renameSync(sessDir, corruptDir);
        console.log(`[session] Quarantined corrupt session to: ${corruptDir}`);
      } catch (renameErr) {
        console.error(`[session] Could not quarantine corrupt session:`, renameErr);
      }
    }
    // Retry with a clean slate — loadUserSession will create a fresh session directory
    userSession = await loadUserSession(state.config, state.coreMemory, userId, wrappedTools);
    state.recoveredSessions.add(userId);
  }

  state.sessions.set(userId, userSession);
  return userSession;
}





/**
 * Write a restart marker and signal the supervisor to restart.
 * Falls back to process.exit(42) if the supervisor callback is not set
 * (running outside the supervisor, like in tests).
 */
async function triggerRestart(
  state: AppState,
  msg: IncomingMessage,
  reason: string,
): Promise<void> {
  console.log(`[restart] Requested by user ${msg.userId}: ${reason}`);
  deletePendingCheckpoint(state.config, msg.userId);
  snapshotConfig(state.config.data_dir);
  writeRestartMarker(state.config.data_dir, {
    userId: msg.userId,
    channelId: msg.channelId,
    platform: msg.platform,
    reason,
  });
  await getBridge(state, msg.platform).sendMessage(
    msg.channelId,
    "Restarting now. Back in a few seconds.",
  );
  if (state.requestRestart) {
    state.requestRestart();
  } else {
    process.exit(RESTART_EXIT_CODE);
  }
}

/**
 * Process an incoming message through the agent.
 *
 * Pipeline (in order):
 *   1. Slash command check — /clear, /memory, /log, /restart handled here, return early
 *   2. Length check — reject messages over 10K chars before they waste context
 *   3. Trust approval check — user may be responding to a pending "Can I use X?" prompt
 *   4. Session load — get or create the persistent session for this user
 *   5. Transcript repair — fix any corrupted tool-call/result pairings from the previous turn
 *   6. System prompt refresh — pick up any core memory changes made last turn
 *   7. Prompt — call the model with fallback chain
 *   8. Usage tracking — log tokens, cost, latency
 *   9. Send — deliver the response text to the channel
 */
async function processMessage(
  state: AppState,
  originalMsg: IncomingMessage,
): Promise<void> {
  let msg = originalMsg;
  // Handle slash commands first
  const wasCommand = await handleSlashCommand(msg, {
    config: state.config,
    coreMemory: state.coreMemory,
    historyManager: state.historyManager,
    disposeSession: (userId: string) => {
      const existing = state.sessions.get(userId);
      if (existing) {
        existing.dispose();
        state.sessions.delete(userId);
        // Delete the session directory so the next message creates a fresh session
        if (fs.existsSync(existing.sessionDir)) {
          fs.rmSync(existing.sessionDir, { recursive: true, force: true });
        }
      }
    },
    sendMessage: (channelId: string, text: string) =>
      getBridge(state, msg.platform).sendMessage(channelId, text),
    triggerRestart: (msg: IncomingMessage, reason: string) =>
      triggerRestart(state, msg, reason),
  });

  if (wasCommand) {
    return;
  }

  // Input validation: reject excessively long messages before they waste context
  const MAX_MESSAGE_LENGTH = 10_000;
  if (msg.text.length > MAX_MESSAGE_LENGTH) {
    await getBridge(state, msg.platform).sendMessage(
      msg.channelId,
      `That message is too long (${msg.text.length.toLocaleString()} characters). ` +
      `Could you break it into smaller pieces? I can handle up to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters at a time.`,
    );
    return;
  }

  // Check for pending trust approvals (user responding to "Can I use X?" prompt)
  const approvedTool = checkPendingApproval(msg.userId, msg.text);
  if (approvedTool) {
    const duration = isAlwaysApproval(msg.text) ? "always" : "once";
    state.trustStore.approve(approvedTool, duration);
    const durLabel = duration === "always" ? "Always allowed" : "Allowed for this time";
    await getBridge(state, msg.platform).sendMessage(
      msg.channelId,
      `${durLabel}: ${approvedTool}. Continuing...`,
    );
    // Don't return; let the message flow through so the agent can retry the tool
  }

  // Track last user message for guardrail context
  state.lastUserMessages.set(msg.userId, msg.text);

  // Show typing indicator
  await getBridge(state, msg.platform).sendTyping(msg.channelId);

  try {
    // Load (or reuse) the persistent session for this user
    const userSession = await getOrLoadSession(state, msg);
    if (state.recoveredSessions.has(msg.userId)) {
      state.recoveredSessions.delete(msg.userId);
      await getBridge(state, msg.platform).sendMessage(
        msg.channelId,
        "I had to start a fresh conversation due to a technical issue. My memory and reminders are intact, just the recent conversation thread was lost.",
      );
    }
    const { session } = userSession;

    // Track last user message time (scheduler messages have raw.type set)
    const rawObj = msg.raw as Record<string, unknown> | null | undefined;
    const schedulerType = rawObj?.type as string | undefined;
    const isSchedulerMessage = schedulerType != null;

    // Daily reviews are context, not urgent. Buffer them so the agent can
    // weave them into the next user-initiated response instead of sending
    // a separate message that feels disconnected.
    if (schedulerType === "projection_daily_review") {
      const pending = state.pendingSchedulerContext.get(msg.userId) ?? [];
      pending.push(msg.text);
      state.pendingSchedulerContext.set(msg.userId, pending);
      console.log(`[scheduler] Buffered daily review for ${msg.userId} (${pending.length} pending)`);
      return;
    }

    if (!isSchedulerMessage) {
      userSession.lastUserMessageAt = Date.now();

      // Prepend restart context so the agent knows why it restarted and can
      // verify or act on it (e.g. confirm a new extension loaded).
      const restartReason = state.pendingRestartContext.get(msg.userId);
      if (restartReason) {
        msg = {
          ...msg,
          text: `[System: you just restarted. Reason: "${restartReason}". Verify the restart achieved its goal and briefly confirm to the user.]\n\n${msg.text}`,
        };
        state.pendingRestartContext.delete(msg.userId);
      }

      // Surface extension load errors so the agent can fix broken extensions.
      // Consumed on first message so the agent sees each error only once.
      if (userSession.extensionErrors.length > 0) {
        const errorLines = userSession.extensionErrors
          .map((e) => `- ${e.path}: ${e.error}`)
          .join("\n");
        msg = {
          ...msg,
          text: `[System: the following extensions failed to load. You wrote these extensions, so diagnose and fix them.\n${errorLines}]\n\n${msg.text}`,
        };
        userSession.extensionErrors = [];
      }

      // Prepend any buffered scheduler context (daily reviews, etc.) so the
      // agent can weave them into a single coherent response instead of
      // sending separate messages for each scheduler event.
      const pending = state.pendingSchedulerContext.get(msg.userId);
      if (pending && pending.length > 0) {
        const schedulerBlock = pending.join("\n\n---\n\n");
        msg = {
          ...msg,
          text: `${schedulerBlock}\n\n---\n\nUser message:\n${msg.text}`,
        };
        state.pendingSchedulerContext.delete(msg.userId);
      }
    }

    // Repair transcript before prompting
    repairSessionTranscript(session, msg.userId);

    // Reload the system prompt so the agent sees any core memory changes
    // it made during the previous turn (memory_core_append / memory_core_replace)
    await refreshSystemPrompt(session);

    // Append user message to audit log (images logged as placeholder, not base64)
    const imageLogSuffix = msg.images && msg.images.length > 0
      ? " " + msg.images.map((img) => {
          const bytes = Math.round(img.data.length * 0.75);
          const kb = Math.round(bytes / 1024);
          return `[image: ${img.mimeType}, ${kb}KB]`;
        }).join(" ")
      : "";
    await state.historyManager.append({
      role: "user",
      content: msg.text + imageLogSuffix,
    });

    // Write a crash-recovery checkpoint before the (potentially long) model call.
    // Deleted after the response is sent. If the process dies in between, the
    // next startup will find this file and notify the user.
    const isUserMessage = !isSchedulerMessage;
    if (isUserMessage) {
      writePendingCheckpoint(state.config, msg);
    }

    // Prompt the agent, with automatic fallback to other models if the primary fails
    const promptStart = Date.now();
    await promptWithFallback(
      session,
      msg.text,
      state.config,
      userSession.modelRegistry,
      msg.userId,
      msg.images,
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
      await getBridge(state, msg.platform).sendMessage(
        msg.channelId,
        "Something went wrong while generating a response. Please try again.",
      );
      return;
    }

    const responseText = extractResponseText(lastAssistant);

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
    } else if (!isSchedulerMessage) {
      // Model made tool calls but produced no text in response to a user
      // message. Re-prompt so the user gets a real reply, not silence.
      console.log(`[agent] No text response from ${msg.userId} after user message, re-prompting`);
      await promptWithFallback(
        session,
        "You just completed tool calls but didn't reply to the user. Respond now with a brief confirmation of what you did.",
        state.config,
        userSession.modelRegistry,
        msg.userId,
      );
      const followUpMsg = toAssistantMessage(
        session.messages.filter((m) => m.role === "assistant").pop(),
      );
      const followUpText = extractResponseText(followUpMsg);
      if (followUpText.trim() && followUpText.trim() !== SILENT_REPLY_TOKEN) {
        await state.historyManager.append({ role: "assistant", content: followUpText });
        await getBridge(state, msg.platform).sendMessage(msg.channelId, followUpText);
      }
    } else {
      // Scheduler/system turn with no text output — normal, suppress silently.
      console.log(`[agent] No text response from ${msg.userId} (scheduler turn), suppressing`);
    }
  } catch (error) {
    const err = error as Error;
    console.error("Error processing message:", err);
    await getBridge(state, msg.platform).sendMessage(
      msg.channelId,
      "Something went wrong processing your message. Please try again.",
    );
  } finally {
    // Always clean up the crash-recovery checkpoint, regardless of outcome.
    // force: true makes this a no-op for scheduler messages (no file was written).
    deletePendingCheckpoint(state.config, msg.userId);
  }
}

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
    pendingRestartContext: new Map(),
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

    // Store the restart reason so the agent can act on it in its next turn.
    state.pendingRestartContext.set(marker.userId, marker.reason);

    if (rolledBack) {
      console.warn(`[config] Config was rolled back due to: ${rollbackReason}`);
      await bridge.sendMessage(
        marker.channelId,
        `Back online, but your config.yml change was invalid and has been rolled back.\n\nError: ${rollbackReason}\n\nThe previous working config is still active.`,
      );
    } else {
      await bridge.sendMessage(marker.channelId, "Back online.");
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

function asError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(String(reason));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Top-level supervisor loop. Starts the app, catches fatal errors, and
 * restarts automatically after a delay.
 *
 * State machine: the `resolver` is a promise resolve function that is set
 * when we're waiting for either a SIGINT/SIGTERM (shutdown) or an uncaught
 * exception (restart). When one fires, it resolves the promise with the
 * appropriate outcome string, the app is stopped, and the loop continues
 * or breaks accordingly. The indirection via `resolver` lets signal handlers
 * and error handlers share a single control path.
 */
async function runWithSupervisor(): Promise<void> {
  const restartDelayMs = Number(process.env.BRYTI_RESTART_DELAY_MS ?? 2000);
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
      app = await startApp(() => resolveOutcome("restart"));
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

/**
 * Start the bryti server. Called from the CLI dispatcher or directly
 * when index.ts is the entry point.
 */
export async function startServer(): Promise<void> {
  await runWithSupervisor();
}

// When run directly (not imported by cli.ts), start immediately.
const isDirectEntry = process.argv[1]?.endsWith("index.js");
if (isDirectEntry) {
  startServer().catch((error) => {
    console.error("Supervisor fatal error:", error);
    process.exit(1);
  });
}
