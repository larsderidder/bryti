/**
 * Bryti entry point.
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
} from "./trust.js";
import { wrapToolsWithTrustChecks, type TrustWrapperContext } from "./trust-wrapper.js";
import {
  calculateCostUsd,
  createUsageTracker,
  resolveModelCost,
  type UsageTracker,
} from "./usage.js";
import { createAppLogger, installConsoleFileLogging } from "./logger.js";
import { getUserTimezone } from "./time.js";

// ---------------------------------------------------------------------------
// Restart protocol
//
// Exit code 42 signals an intentional restart to run.sh, which loops
// immediately without delay (as opposed to crash restarts which delay).
//
// A small marker file records who triggered the restart and on which channel,
// so the "Back online" notification can be sent to the right user on startup.
// ---------------------------------------------------------------------------

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

function readAndClearRestartMarker(dataDir: string): RestartMarker | null {
  const p = restartMarkerPath(dataDir);
  if (!fs.existsSync(p)) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(p, "utf8")) as RestartMarker;
    fs.rmSync(p, { force: true });
    return marker;
  } catch {
    fs.rmSync(p, { force: true });
    return null;
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
  /** Enqueue function for injecting messages (used by worker trigger callbacks). */
  enqueue: ((msg: IncomingMessage) => void) | null;
  /** Trust store for runtime permission checks. */
  trustStore: TrustStore;
  /** Last user message per userId (for guardrail context). */
  lastUserMessages: Map<string, string>;
  /** Users whose session was recovered after corruption — notified on next message. */
  recoveredSessions: Set<string>;
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
    // Agent-triggered restart. Send notification then exit 42.
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

// ---------------------------------------------------------------------------
// Crash recovery: pending-message checkpoints
// ---------------------------------------------------------------------------

interface PendingCheckpoint {
  text: string;
  channelId: string;
  platform: string;
  timestamp: number;
}

function pendingDir(config: Config): string {
  return path.join(config.data_dir, "pending");
}

function pendingPath(config: Config, userId: string): string {
  return path.join(pendingDir(config), `${userId}.json`);
}

function writePendingCheckpoint(config: Config, msg: IncomingMessage): void {
  const checkpoint: PendingCheckpoint = {
    text: msg.text,
    channelId: msg.channelId,
    platform: msg.platform,
    timestamp: Date.now(),
  };
  try {
    fs.writeFileSync(pendingPath(config, msg.userId), JSON.stringify(checkpoint), "utf8");
  } catch (err) {
    console.warn("[pending] Failed to write checkpoint:", (err as Error).message);
  }
}

function deletePendingCheckpoint(config: Config, userId: string): void {
  try {
    fs.rmSync(pendingPath(config, userId), { force: true });
  } catch (err) {
    console.warn("[pending] Failed to delete checkpoint:", (err as Error).message);
  }
}

/**
 * On startup, scan for leftover pending files from a previous crash.
 * For each stale file (between 2 min and 1 hour old), notify the user.
 * Files older than 1 hour are silently discarded.
 */
async function recoverPendingCheckpoints(state: AppState): Promise<void> {
  const dir = pendingDir(state.config);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "restart.json");
  } catch {
    return;
  }

  if (entries.length === 0) return;

  const now = Date.now();
  const MIN_AGE_MS = 2 * 60 * 1000;   // 2 minutes: ignore files written moments before a clean restart
  const MAX_AGE_MS = 60 * 60 * 1000;  // 1 hour: too stale to be useful

  // Group by userId (filename = <userId>.json), keep most recent per user
  const byUser = new Map<string, { checkpoint: PendingCheckpoint; filePath: string }>();

  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    let checkpoint: PendingCheckpoint;
    try {
      checkpoint = JSON.parse(fs.readFileSync(filePath, "utf8")) as PendingCheckpoint;
    } catch {
      fs.rmSync(filePath, { force: true });
      continue;
    }

    const userId = entry.slice(0, -5); // strip .json
    const existing = byUser.get(userId);
    if (!existing || checkpoint.timestamp > existing.checkpoint.timestamp) {
      byUser.set(userId, { checkpoint, filePath });
    }
  }

  for (const [userId, { checkpoint, filePath }] of byUser) {
    const age = now - checkpoint.timestamp;

    // Always delete the file first to prevent repeat notifications on the next restart
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // ignore
    }

    if (age < MIN_AGE_MS || age > MAX_AGE_MS) {
      console.log(`[pending] Skipping stale checkpoint for ${userId} (age ${Math.round(age / 1000)}s)`);
      continue;
    }

    console.log(`[pending] Crash recovery: notifying ${userId} (age ${Math.round(age / 1000)}s)`);
    try {
      const bridge = getBridge(state, checkpoint.platform);
      await bridge.sendMessage(
        checkpoint.channelId,
        "Sorry, I crashed while working on your last message. Could you resend it?",
      );
    } catch (err) {
      console.warn(`[pending] Failed to notify ${userId}:`, (err as Error).message);
    }
  }
}

// ---------------------------------------------------------------------------
// /log — recent activity audit
// ---------------------------------------------------------------------------

/**
 * Maps internal tool names to human-readable descriptions for the /log output.
 * Follows the same "never leak tool names" rule used elsewhere in the system.
 */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  memory_archival_search: "Searched memory",
  memory_archival_insert: "Saved a memory",
  memory_core_append: "Updated core memory",
  memory_core_replace: "Updated core memory",
  memory_conversation_search: "Searched conversation history",
  projection_create: "Set a reminder",
  projection_resolve: "Resolved a reminder",
  projection_list: "Checked upcoming reminders",
  projection_link: "Linked memory to a reminder",
  worker_dispatch: "Started background research",
  worker_check: "Checked background task",
  worker_interrupt: "Cancelled a background task",
  worker_steer: "Adjusted a background task",
  file_read: "Read a file",
  file_write: "Wrote a file",
  file_list: "Listed files",
};

interface ToolCallLogEntry {
  timestamp: string;
  userId: string;
  toolName: string;
  args_summary: string;
}

/**
 * Read the tool call log, filter to the given user, and format a
 * human-readable activity summary for display.
 */
function buildActivityLog(dataDir: string, userId: string, timezone: string): string {
  const logPath = path.join(dataDir, "logs", "tool-calls.jsonl");

  if (!fs.existsSync(logPath)) {
    return "No recent activity on record yet.";
  }

  let entries: ToolCallLogEntry[];
  try {
    const raw = fs.readFileSync(logPath, "utf-8");
    entries = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as ToolCallLogEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is ToolCallLogEntry => entry !== null);
  } catch {
    return "Could not read the activity log.";
  }

  // Filter to this user, take the last 20 entries
  const userEntries = entries
    .filter((e) => e.userId === userId)
    .slice(-20);

  if (userEntries.length === 0) {
    return "No recent activity on record yet.";
  }

  const lines = userEntries.map((entry) => {
    const ts = new Date(entry.timestamp);
    const time = ts.toLocaleString("sv-SE", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const description = TOOL_DESCRIPTIONS[entry.toolName] ?? "Ran a task";
    const detail = entry.args_summary ? `: ${entry.args_summary}` : "";
    return `- ${time}  ${description}${detail}`;
  });

  return `Recent activity:\n${lines.join("\n")}`;
}

/**
 * Write a restart marker and exit with code 42.
 *
 * run.sh treats exit 42 as an intentional restart: it loops immediately
 * without delay or error logging. On next startup, the marker is read and
 * a "Back online" message is sent to the user who triggered the restart.
 */
async function triggerRestart(
  state: AppState,
  msg: IncomingMessage,
  reason: string,
): Promise<void> {
  console.log(`[restart] Requested by user ${msg.userId}: ${reason}`);
  deletePendingCheckpoint(state.config, msg.userId);
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
  process.exit(RESTART_EXIT_CODE);
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

  if (msg.text === "/log") {
    const logText = buildActivityLog(state.config.data_dir, msg.userId, getUserTimezone(state.config));
    await getBridge(state, msg.platform).sendMessage(msg.channelId, logText);
    return;
  }

  if (msg.text === "/restart") {
    await triggerRestart(state, msg, "user command");
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
    const isSchedulerMessage = rawObj?.type != null;
    if (!isSchedulerMessage) {
      userSession.lastUserMessageAt = Date.now();
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
  } finally {
    // Always clean up the crash-recovery checkpoint, regardless of outcome.
    // force: true makes this a no-op for scheduler messages (no file was written).
    deletePendingCheckpoint(state.config, msg.userId);
  }
}

/**
 * Start one app instance.
 */
async function startApp(): Promise<RunningApp> {
  const config = loadConfig();
  applyIntegrationEnvVars(config);
  ensureDataDirs(config);
  installConsoleFileLogging(createAppLogger(config.data_dir));

  console.log(`Bryti starting: agent="${config.agent.name}" model="${config.agent.model}"`);
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
  const trustStore = createTrustStore(config.data_dir, config.trust.approved_tools);

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
    enqueue: null,
    trustStore,
    lastUserMessages: new Map(),
    recoveredSessions: new Set(),
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

  // Recover any pending messages from a previous crash
  await recoverPendingCheckpoints(state);

  // If this startup was triggered by a restart request, notify the user
  const restartMarker = readAndClearRestartMarker(config.data_dir);
  if (restartMarker) {
    console.log(`[restart] Back online after restart requested by ${restartMarker.userId}: ${restartMarker.reason}`);
    const bridge = bridges.find((b) => b.platform === restartMarker.platform) ?? bridges[0];
    await bridge.sendMessage(restartMarker.channelId, "Back online.");
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
