/**
 * Message processing pipeline and session management.
 *
 * Extracted from index.ts to keep that file focused on wiring (bridges,
 * scheduler, startup) while this module owns the per-message logic.
 *
 * Public surface:
 *   - AppState          — shared mutable state passed to every handler
 *   - processMessage()  — full pipeline: slash-cmd → trust → session → prompt → send
 *   - getOrLoadSession() — session factory (cached per userId in state.sessions)
 *   - getBridge()       — pick the right channel bridge for a platform
 *   - triggerRestart()  — write restart marker + signal supervisor
 */

import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import {
  RESTART_EXIT_CODE,
  writeRestartMarker,
  snapshotConfig,
} from "./restart.js";
import { createCoreMemory, type CoreMemory } from "./memory/core-memory.js";
import { createHistoryManager, type HistoryManager } from "./history.js";
import { createTools } from "./tools/index.js";
import {
  loadUserSession,
  repairSessionTranscript,
  refreshSystemPrompt,
  promptWithFallback,
  SILENT_REPLY_TOKEN,
  type UserSession,
} from "./agent.js";
import { createProjectionStore } from "./projection/index.js";
import { createModelInfra } from "./model-infra.js";
import type { Scheduler } from "./scheduler.js";
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
import { handleSlashCommand } from "./commands.js";
import {
  writePendingCheckpoint,
  deletePendingCheckpoint,
} from "./crash-recovery.js";

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

/**
 * Application state shared across all message handlers for a single app
 * instance. Created once in startApp() and passed by reference everywhere.
 */
export interface AppState {
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
   */
  enqueue: ((msg: IncomingMessage) => void) | null;
  /** Trust store for runtime permission checks. */
  trustStore: TrustStore;
  /**
   * Last user-initiated message text per userId, for guardrail context.
   */
  lastUserMessages: Map<string, string>;
  /** Users whose session was recovered after corruption — notified on next message. */
  recoveredSessions: Set<string>;
  /**
   * Signal the supervisor to restart the app. Set by runWithSupervisor().
   * Falls back to process.exit(RESTART_EXIT_CODE) when null.
   */
  requestRestart: (() => void) | null;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Small helpers (pure / no I/O)
// ---------------------------------------------------------------------------

function toAssistantMessage(message: unknown): AssistantMessageLike | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as { role?: unknown };
  if (candidate.role !== "assistant") return undefined;
  return message as AssistantMessageLike;
}

/** Extract plain text from an assistant message (ignores tool calls, thinking). */
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
  if (provider && model) return `${provider}/${model}`;
  return model || fallback;
}

// ---------------------------------------------------------------------------
// getBridge
// ---------------------------------------------------------------------------

/**
 * Find the bridge for a platform, falling back to the first available one.
 */
export function getBridge(state: AppState, platform?: string): ChannelBridge {
  if (platform) {
    const match = state.bridges.find((b) => b.platform === platform);
    if (match) return match;
  }
  return state.bridges[0];
}

// ---------------------------------------------------------------------------
// triggerRestart
// ---------------------------------------------------------------------------

/**
 * Write a restart marker and signal the supervisor to restart.
 * Falls back to process.exit(RESTART_EXIT_CODE) when running outside
 * the supervisor (tests, CLI).
 */
export async function triggerRestart(
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

// ---------------------------------------------------------------------------
// getOrLoadSession
// ---------------------------------------------------------------------------

/**
 * Get or load the persistent session for a user.
 *
 * On first call for a userId, creates a ModelInfra and ProjectionStore shared
 * between the tool set and the session. On subsequent calls returns the cached
 * session from state.sessions.
 */
export async function getOrLoadSession(
  state: AppState,
  msg: IncomingMessage,
): Promise<UserSession> {
  const { userId, channelId, platform } = msg;
  const existing = state.sessions.get(userId);
  if (existing) return existing;

  const modelInfra = createModelInfra(state.config);

  const projectionStore = createProjectionStore(userId, state.config.data_dir);

  const tools = createTools(
    state.config,
    state.coreMemory,
    userId,
    (triggered) => {
      if (!state.enqueue) return;
      const channelId = String(state.config.telegram.allowed_users[0] ?? userId);
      const summaries = triggered.map((p) => `- ${p.summary} (id: ${p.id})`).join("\n");
      state.enqueue({
        channelId,
        userId,
        text:
          `[Worker completed]\n\nThe following commitment(s) were triggered:\n\n${summaries}\n\n` +
          `IMPORTANT: The user has NOT seen the worker's results yet. You must:\n` +
          `1. Read the worker's result file (read tool)\n` +
          `2. Share the key findings with the user FIRST\n` +
          `3. Only THEN suggest next steps or act on them\n` +
          `Never assume the user knows what the worker found. Always present the findings before drawing conclusions or taking action.`,
        platform: "telegram",
        raw: { type: "worker_trigger" },
      });
    },
    async (reason: string) => {
      await triggerRestart(state, { userId, channelId, platform, text: "", raw: null }, reason);
    },
    projectionStore,
  );

  const trustContext: TrustWrapperContext = {
    config: state.config,
    modelInfra,
    getLastUserMessage: () => state.lastUserMessages.get(userId),
    onApprovalNeeded: async (prompt, approvalKey) => {
      const bridge = getBridge(state, platform);
      return bridge.sendApprovalRequest(channelId, prompt, approvalKey);
    },
  };
  const wrappedTools = wrapToolsWithTrustChecks(
    tools,
    state.trustStore,
    userId,
    trustContext,
  );

  const sessDir = path.join(state.config.data_dir, "sessions", userId);

  let userSession: UserSession;
  try {
    userSession = await loadUserSession(
      state.config,
      state.coreMemory,
      userId,
      wrappedTools,
      projectionStore,
    );
  } catch (err) {
    console.error(
      `[session] Failed to load session for user ${userId}, attempting recovery:`,
      err,
    );
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
    userSession = await loadUserSession(
      state.config,
      state.coreMemory,
      userId,
      wrappedTools,
      projectionStore,
    );
    state.recoveredSessions.add(userId);
  }

  userSession.onCompactionComplete = () => {
    const channelId = String(state.config.telegram.allowed_users[0] ?? userId);
    const compactionMsg: IncomingMessage = {
      channelId,
      userId,
      platform: "telegram",
      text:
        "[System: context was automatically compacted. If you were in the middle of a task " +
        "for the user, continue where you left off. If not, say nothing (NOOP).]",
      raw: { type: "compaction_resume" },
    };
    state.enqueue?.(compactionMsg);
  };

  // Wrap dispose so this module closes the store it owns.
  const originalDispose = userSession.dispose.bind(userSession);
  userSession.dispose = () => {
    originalDispose();
    projectionStore.close();
  };

  state.sessions.set(userId, userSession);
  return userSession;
}

// ---------------------------------------------------------------------------
// processMessage
// ---------------------------------------------------------------------------

/**
 * Process an incoming message through the agent.
 *
 * Pipeline (in order):
 *   1. Slash command check — /clear, /memory, /log, /restart handled here
 *   2. Length check — reject messages over 10K chars
 *   3. Trust approval check — user responding to a pending "Can I use X?" prompt
 *   4. Session load — get or create the persistent session for this user
 *   5. Transcript repair — fix corrupted tool-call/result pairings
 *   6. System prompt refresh — pick up core memory changes from the previous turn
 *   7. Prompt — call the model with fallback chain
 *   8. Usage tracking — log tokens, cost, latency
 *   9. Send — deliver response text to the channel
 */
export async function processMessage(
  state: AppState,
  originalMsg: IncomingMessage,
): Promise<void> {
  let msg = originalMsg;

  const wasCommand = await handleSlashCommand(msg, {
    config: state.config,
    coreMemory: state.coreMemory,
    historyManager: state.historyManager,
    disposeSession: (userId: string) => {
      const existing = state.sessions.get(userId);
      if (existing) {
        existing.dispose();
        state.sessions.delete(userId);
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

  if (wasCommand) return;

  const MAX_MESSAGE_LENGTH = 10_000;
  if (msg.text.length > MAX_MESSAGE_LENGTH) {
    await getBridge(state, msg.platform).sendMessage(
      msg.channelId,
      `That message is too long (${msg.text.length.toLocaleString()} characters). ` +
        `Could you break it into smaller pieces? I can handle up to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters at a time.`,
    );
    return;
  }

  const approvedTool = checkPendingApproval(msg.userId, msg.text);
  if (approvedTool) {
    const duration = isAlwaysApproval(msg.text) ? "always" : "once";
    state.trustStore.approve(approvedTool, duration);
    const durLabel = duration === "always" ? "Always allowed" : "Allowed for this time";
    await getBridge(state, msg.platform).sendMessage(
      msg.channelId,
      `${durLabel}: ${approvedTool}. Continuing...`,
    );
  }

  state.lastUserMessages.set(msg.userId, msg.text);

  await getBridge(state, msg.platform).sendTyping(msg.channelId);

  try {
    const userSession = await getOrLoadSession(state, msg);
    if (state.recoveredSessions.has(msg.userId)) {
      state.recoveredSessions.delete(msg.userId);
      await getBridge(state, msg.platform).sendMessage(
        msg.channelId,
        "I had to start a fresh conversation due to a technical issue. My memory and reminders are intact, just the recent conversation thread was lost.",
      );
    }
    const { session } = userSession;

    const rawObj = msg.raw as Record<string, unknown> | null | undefined;
    const schedulerType = rawObj?.type as string | undefined;
    const isSchedulerMessage = schedulerType != null;

    if (!isSchedulerMessage) {
      userSession.lastUserMessageAt = Date.now();

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
    }

    repairSessionTranscript(session, msg.userId);
    await refreshSystemPrompt(session);

    const imageLogSuffix =
      msg.images && msg.images.length > 0
        ? " " +
          msg.images
            .map((img) => {
              const bytes = Math.round(img.data.length * 0.75);
              const kb = Math.round(bytes / 1024);
              return `[image: ${img.mimeType}, ${kb}KB]`;
            })
            .join(" ")
        : "";
    await state.historyManager.append({
      role: "user",
      content: msg.text + imageLogSuffix,
    });

    const isUserMessage = !isSchedulerMessage;
    if (isUserMessage) {
      writePendingCheckpoint(state.config, msg);
    }

    // Track message count before prompt so we can find all new messages after.
    const messageCountBefore = session.messages.length;

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

    const lastAssistant = toAssistantMessage(
      session.messages.filter((m) => m.role === "assistant").pop(),
    );

    // Collect text from ALL assistant messages generated during this turn,
    // not just the last one. The model may produce text in intermediate
    // turns (between tool calls) that the user should see.
    const newAssistantMessages = session.messages
      .slice(messageCountBefore)
      .filter((m) => m.role === "assistant")
      .map((m) => toAssistantMessage(m))
      .filter((m): m is NonNullable<typeof m> => m != null);

    const allResponseTexts: string[] = [];
    for (const assistantMsg of newAssistantMessages) {
      const text = extractResponseText(assistantMsg).trim();
      if (text && text !== SILENT_REPLY_TOKEN) {
        allResponseTexts.push(text);
      }
    }

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

    const ctxUsage = session.getContextUsage();
    if (ctxUsage?.percent !== null && ctxUsage?.percent !== undefined) {
      const tokensStr =
        ctxUsage.tokens !== null
          ? `${Math.round(ctxUsage.tokens / 1000)}K/${Math.round(ctxUsage.contextWindow / 1000)}K`
          : `?/${Math.round(ctxUsage.contextWindow / 1000)}K`;
      const logFn = ctxUsage.percent > 80 ? console.warn : console.log;
      logFn(
        `[context] ${tokensStr} tokens (${Math.round(ctxUsage.percent)}%) for user ${msg.userId}`,
      );
    }

    if (lastAssistant?.stopReason === "error") {
      const errorMsg = String(lastAssistant.errorMessage ?? "Unknown model error");
      console.error("Model error:", errorMsg);
      await getBridge(state, msg.platform).sendMessage(
        msg.channelId,
        "Something went wrong while generating a response. Please try again.",
      );
      return;
    }

    // Send ALL text the agent produced during this turn, not just the last
    // message. Intermediate text (between tool calls) would otherwise be
    // silently swallowed — the user never sees it.
    // Filter out any NOOP entries — only suppress if ALL entries are NOOP.
    const visibleTexts = allResponseTexts.filter((t) => t !== SILENT_REPLY_TOKEN);

    if (allResponseTexts.length > 0 && visibleTexts.length === 0) {
      console.log(`[agent] Silent reply from ${msg.userId}, suppressing message`);
    } else if (visibleTexts.length > 0) {
      const combinedText = visibleTexts.join("\n\n");
      await state.historyManager.append({
        role: "assistant",
        content: combinedText,
      });
      await getBridge(state, msg.platform).sendMessage(msg.channelId, combinedText);
    } else if (!isSchedulerMessage) {
      console.log(
        `[agent] No text response from ${msg.userId} after user message, re-prompting`,
      );
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
      console.log(
        `[agent] No text response from ${msg.userId} (scheduler turn), suppressing`,
      );
    }
  } catch (error) {
    const err = error as Error;
    console.error("Error processing message:", err);
    await getBridge(state, msg.platform).sendMessage(
      msg.channelId,
      "Something went wrong processing your message. Please try again.",
    );
  } finally {
    deletePendingCheckpoint(state.config, msg.userId);
  }
}
