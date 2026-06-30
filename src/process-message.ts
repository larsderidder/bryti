/**
 * Message processing pipeline and session management.
 *
 * Extracted from index.ts to keep that file focused on wiring (bridges,
 * scheduler, startup) while this module owns the per-message logic.
 *
 * Public surface:
 *   - AppState          — shared mutable state passed to every handler
 *   - processMessage()  — full pipeline: slash-cmd → trust → session → prompt → send
 *   - getOrLoadSession() — session factory (cached per user/thread in state.sessions)
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
import type { AudioAttachment, IncomingMessage, ChannelBridge } from "./channels/types.js";
import type { VoiceService } from "./voice.js";
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
import { DEFAULT_THREAD_ID, getActiveThread, getSessionKey } from "./threads.js";
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
  /** Persistent session cache: one session per user/thread. */
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
  /** Optional speech-to-text/text-to-speech service. Present only when voice is enabled. */
  voiceService?: VoiceService | null;
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

function stripThinkingTags(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function extractThinkingText(block: Record<string, unknown>): string {
  if (typeof block.thinking === "string" && block.thinking.trim()) {
    return block.thinking.trim();
  }

  const summary = block.summary;
  if (Array.isArray(summary)) {
    return summary
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        return String((entry as Record<string, unknown>).text ?? "").trim();
      })
      .filter(Boolean)
      .join("\n\n");
  }

  return "";
}

function formatThinkingBlock(thinking: string): string {
  const quoted = thinking
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> Thinking:\n${quoted}`;
}

/** Extract user-visible plain text from an assistant message. */
function extractResponseText(
  msg: AssistantMessageLike | undefined,
  opts: { showThinking?: boolean } = {},
): string {
  if (!msg || !("content" in msg)) return "";
  const content = msg.content;
  if (Array.isArray(content)) {
    return content
      .map((c: Record<string, unknown>) => {
        if (c.type === "text") return String(c.text ?? "");
        if (opts.showThinking && (c.type === "thinking" || c.type === "reasoning")) {
          const thinking = extractThinkingText(c);
          return thinking ? `\n\n${formatThinkingBlock(thinking)}` : "";
        }
        return "";
      })
      .join("")
      .trim();
  }
  if (typeof content === "string") {
    return opts.showThinking ? content : stripThinkingTags(content);
  }
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

const DEFAULT_VOICE_MESSAGE_TEXT = "The user sent a voice message.";

function shouldKeepVoiceTempFiles(state: AppState): boolean {
  return state.config.voice?.keep_temp_files === true;
}

function cleanupPath(kind: "incoming" | "outgoing", filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (err) {
    const label = path.basename(filePath) || `${kind} temp file`;
    console.warn(`[voice] Failed to clean up ${kind} temp file (${label}):`, (err as Error).message);
  }
}

function cleanupIncomingAudioFiles(state: AppState, audio?: AudioAttachment[]): void {
  if (shouldKeepVoiceTempFiles(state) || !audio || audio.length === 0) return;
  for (const attachment of audio) {
    if (attachment?.path) cleanupPath("incoming", attachment.path);
  }
}

function cleanupOutgoingAudioFile(state: AppState, audioPath: string): void {
  if (shouldKeepVoiceTempFiles(state) || !audioPath) return;
  cleanupPath("outgoing", audioPath);
}

function voicePromptText(transcript: string, originalText: string): string {
  const cleaned = originalText.trim();
  const parts = ["[Voice message transcript]", transcript.trim()];
  if (cleaned && cleaned !== DEFAULT_VOICE_MESSAGE_TEXT) {
    parts.push("", "[User caption/message]", cleaned);
  }
  return parts.join("\n");
}

async function prepareVoiceMessage(state: AppState, msg: IncomingMessage): Promise<IncomingMessage | null> {
  if (!msg.audio || msg.audio.length === 0) {
    return msg;
  }

  const bridge = getBridge(state, msg.platform);
  if (!state.config.voice?.enabled) {
    cleanupIncomingAudioFiles(state, msg.audio);
    await bridge.sendMessage(msg.channelId, "Voice messages are not enabled. Please send text instead.");
    return null;
  }
  if (!state.voiceService) {
    cleanupIncomingAudioFiles(state, msg.audio);
    await bridge.sendMessage(msg.channelId, "Voice support is enabled but unavailable. Please send text instead.");
    return null;
  }

  try {
    const transcript = await state.voiceService.transcribe(msg.audio);
    cleanupIncomingAudioFiles(state, msg.audio);
    return {
      ...msg,
      text: voicePromptText(transcript, msg.text),
    };
  } catch (err) {
    cleanupIncomingAudioFiles(state, msg.audio);
    console.warn(`[voice] Transcription failed for ${msg.userId}:`, (err as Error).message);
    await bridge.sendMessage(msg.channelId, "I couldn't transcribe that voice message. Please send text or try again.");
    return null;
  }
}

function sendOptsFor(msg: IncomingMessage): { channelThreadId?: string } {
  return msg.channelThreadId ? { channelThreadId: msg.channelThreadId } : {};
}

async function sendAssistantResponse(state: AppState, msg: IncomingMessage, text: string): Promise<void> {
  const bridge = getBridge(state, msg.platform);
  if (
    msg.replyMode === "voice" &&
    state.config.voice?.enabled &&
    state.config.voice.reply_with_voice &&
    state.voiceService &&
    bridge.sendVoice
  ) {
    let audioPath = "";
    try {
      audioPath = await state.voiceService.synthesize(text);
      await bridge.sendVoice(msg.channelId, audioPath, sendOptsFor(msg));
      cleanupOutgoingAudioFile(state, audioPath);
      return;
    } catch (err) {
      if (audioPath) cleanupOutgoingAudioFile(state, audioPath);
      console.warn(`[voice] Synthesis/send failed for ${msg.userId}, falling back to text:`, (err as Error).message);
    }
  }

  await bridge.sendMessage(msg.channelId, text, sendOptsFor(msg));
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
    channelThreadId: msg.channelThreadId,
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
 * Get or load the persistent session for a user thread.
 *
 * On first call for a user/thread, creates a ModelInfra and ProjectionStore shared
 * between the tool set and the session. On subsequent calls returns the cached
 * session from state.sessions.
 */
export async function getOrLoadSession(
  state: AppState,
  msg: IncomingMessage,
): Promise<UserSession> {
  const { userId, channelId, platform } = msg;
  const threadId = msg.threadId ?? DEFAULT_THREAD_ID;
  const sessionKey = getSessionKey(userId, threadId);
  const existing = state.sessions.get(sessionKey);
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
        threadId,
        channelThreadId: msg.channelThreadId,
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
      return bridge.sendApprovalRequest(channelId, prompt, approvalKey, undefined, sendOptsFor(msg));
    },
  };
  const wrappedTools = wrapToolsWithTrustChecks(
    tools,
    state.trustStore,
    userId,
    trustContext,
  );

  const sessDir = path.join(state.config.data_dir, "sessions", sessionKey);

  let userSession: UserSession;
  try {
    userSession = await loadUserSession(
      state.config,
      state.coreMemory,
      userId,
      wrappedTools,
      projectionStore,
      sessionKey,
    );
  } catch (err) {
    console.error(
      `[session] Failed to load session for user ${userId}, attempting recovery:`,
      err,
    );
    const corruptDir = path.join(
      state.config.data_dir,
      "sessions",
      `${sessionKey}-corrupt-${Date.now()}`,
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
      sessionKey,
    );
    state.recoveredSessions.add(sessionKey);
  }

  userSession.onCompactionComplete = () => {
    const channelId = String(state.config.telegram.allowed_users[0] ?? userId);
    const compactionMsg: IncomingMessage = {
      channelId,
      userId,
      platform: "telegram",
      threadId,
      channelThreadId: msg.channelThreadId,
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

  state.sessions.set(sessionKey, userSession);
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
    disposeSession: (userId: string, threadId = DEFAULT_THREAD_ID) => {
      const sessionKey = getSessionKey(userId, threadId);
      const existing = state.sessions.get(sessionKey);
      if (existing) {
        existing.dispose();
        state.sessions.delete(sessionKey);
        if (fs.existsSync(existing.sessionDir)) {
          fs.rmSync(existing.sessionDir, { recursive: true, force: true });
        }
        return;
      }

      const sessionDir = path.join(state.config.data_dir, "sessions", sessionKey);
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    },
    sendMessage: (channelId: string, text: string) =>
      getBridge(state, msg.platform).sendMessage(channelId, text, sendOptsFor(msg)),
    triggerRestart: (msg: IncomingMessage, reason: string) =>
      triggerRestart(state, msg, reason),
  });

  if (wasCommand) return;

  msg = {
    ...msg,
    threadId: msg.threadId ?? getActiveThread(state.config.data_dir, msg.userId),
  };

  const voicePreparedMsg = await prepareVoiceMessage(state, msg);
  if (!voicePreparedMsg) return;
  msg = voicePreparedMsg;

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

  await getBridge(state, msg.platform).sendTyping(msg.channelId, sendOptsFor(msg));

  try {
    const userSession = await getOrLoadSession(state, msg);
    const sessionKey = getSessionKey(msg.userId, msg.threadId ?? DEFAULT_THREAD_ID);
    if (state.recoveredSessions.has(sessionKey)) {
      state.recoveredSessions.delete(sessionKey);
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
    // Guard against stuck model or tool calls. session.abort() is best-effort,
    // so the timeout must resolve this turn even if the SDK await never unwinds.
    const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
    let promptTimeout: ReturnType<typeof setTimeout> | null = null;
    const promptPromise = promptWithFallback(
      session,
      msg.text,
      state.config,
      userSession.modelRegistry,
      msg.userId,
      msg.images,
    );
    const promptResult = await Promise.race([
      promptPromise.then(() => "completed" as const),
      new Promise<"timeout">((resolve) => {
        promptTimeout = setTimeout(() => {
          console.error(`[agent] Prompt for ${sessionKey} exceeded ${PROMPT_TIMEOUT_MS / 1000}s, aborting`);
          try {
            void session.abort();
          } catch (err) {
            console.warn(`[agent] Failed to abort timed-out prompt for ${sessionKey}:`, (err as Error).message);
          }
          resolve("timeout");
        }, PROMPT_TIMEOUT_MS);
      }),
    ]);
    if (promptTimeout) clearTimeout(promptTimeout);

    // Avoid unhandled rejections if the timed-out SDK call eventually finishes
    // after this request has already been evicted from the session cache.
    promptPromise.catch((err) => {
      console.warn(`[agent] Timed-out prompt for ${sessionKey} later rejected:`, (err as Error).message);
    });

    // If the prompt was aborted due to timeout, the in-memory session state
    // is unreliable (partially updated). Evict it from the cache so the next
    // message reloads from the JSONL file (the source of truth).
    if (promptResult === "timeout") {
      console.log(`[agent] Evicting session for ${sessionKey} after timeout abort`);
      try {
        await getBridge(state, msg.platform).sendMessage(
          msg.channelId,
          "One of my tools took too long and I had to stop. Please resend your message.",
          sendOptsFor(msg),
        );
      } catch {
        // Best-effort — don't let a send failure mask the eviction
      }
      userSession.dispose();
      state.sessions.delete(sessionKey);
      return;
    }
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
    const showThinking = state.config.response?.show_thinking === true;
    for (const assistantMsg of newAssistantMessages) {
      const text = extractResponseText(assistantMsg, { showThinking }).trim();
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
      await sendAssistantResponse(state, msg, combinedText);
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
      const followUpText = extractResponseText(followUpMsg, { showThinking: state.config.response?.show_thinking === true });
      if (followUpText.trim() && followUpText.trim() !== SILENT_REPLY_TOKEN) {
        await state.historyManager.append({ role: "assistant", content: followUpText });
        await sendAssistantResponse(state, msg, followUpText);
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
