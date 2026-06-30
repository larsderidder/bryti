/**
 * Telegram bridge using grammy.
 *
 * ChannelBridge for Telegram DMs. Long polling for now, webhook later.
 *
 * All outgoing messages use HTML parse mode. LLM markdown output is converted
 * via a proper markdown IR (not regex) before sending. HTML is far simpler
 * than MarkdownV2, which requires escaping 18 characters and breaks constantly
 * on LLM output.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { ApprovalResult, AudioAttachment, ChannelBridge, IncomingMessage, SendOpts } from "./types.js";
import { markdownToIR, chunkMarkdownIR, type MarkdownLinkSpan } from "./markdown/ir.js";
import { renderMarkdownWithMarkers } from "./markdown/render.js";
import {
  isRecoverableTelegramNetworkError,
  isRetryableGetFileError,
  isFileTooBigError,
} from "./telegram-network-errors.js";
import { fetchWithTimeout, withTimeout } from "../util/timeout.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Telegram message handler function.
 */
type MessageHandler = (msg: IncomingMessage) => Promise<void>;


// ---------------------------------------------------------------------------
// HTML escape helpers
// ---------------------------------------------------------------------------

/**
 * Escape the three HTML special characters that Telegram HTML mode requires.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function buildTelegramLink(link: MarkdownLinkSpan, _text: string) {
  const href = link.href.trim();
  if (!href || link.start === link.end) return null;
  return {
    start: link.start,
    end: link.end,
    open: `<a href="${escapeHtmlAttr(href)}">`,
    close: "</a>",
  };
}

// ---------------------------------------------------------------------------
// Markdown conversion pipeline
//
// The pipeline is two-step: markdown → IR (intermediate representation) → HTML.
// The IR is a structured token list that tracks span boundaries precisely.
// This matters for chunking: splitting after IR parsing means we can find safe
// break points between tokens rather than inside them. Cutting a raw markdown
// string mid-fence or mid-span would produce broken HTML on the far side.
// ---------------------------------------------------------------------------

/** Telegram's maximum message length in characters. */
const MAX_MESSAGE_LENGTH = 4096;

const TELEGRAM_RENDER_OPTIONS = {
  styleMarkers: {
    bold: { open: "<b>", close: "</b>" },
    italic: { open: "<i>", close: "</i>" },
    strikethrough: { open: "<s>", close: "</s>" },
    code: { open: "<code>", close: "</code>" },
    code_block: { open: "<pre><code>", close: "</code></pre>" },
  },
  escapeText: escapeHtml,
  buildLink: buildTelegramLink,
} as const;

const TELEGRAM_IR_OPTIONS = {
  linkify: true,
  headingStyle: "bold" as const,
  blockquotePrefix: "",
  tableMode: "bullets" as const,
};

/**
 * Convert LLM markdown to Telegram HTML via the markdown IR.
 * Handles bold, italic, strikethrough, code, links, headings (as bold),
 * and tables (as bullet lists, since Telegram has no table support).
 */
export function markdownToHtml(text: string): string {
  const ir = markdownToIR(text ?? "", TELEGRAM_IR_OPTIONS);
  return renderMarkdownWithMarkers(ir, TELEGRAM_RENDER_OPTIONS);
}

/**
 * Parse markdown into an IR, split at semantic boundaries, and render each
 * chunk to Telegram HTML. Splitting after IR parsing means code blocks,
 * bold spans, and links are never cut in half.
 */
export function markdownToTelegramChunks(text: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  if (!text) return [];
  const ir = markdownToIR(text, TELEGRAM_IR_OPTIONS);
  const irChunks = chunkMarkdownIR(ir, maxLength);
  return irChunks.map((chunk) => renderMarkdownWithMarkers(chunk, TELEGRAM_RENDER_OPTIONS));
}

// ---------------------------------------------------------------------------
// Message chunking
// ---------------------------------------------------------------------------

/** Maximum retry attempts for send/edit operations. */
const MAX_SEND_RETRIES = 3;

/** Base delay for retry backoff in milliseconds. */
const RETRY_BASE_DELAY_MS = 1000;

/**
 * How long to wait for more photos in the same album before flushing.
 * Telegram sends album photos as separate updates within ~100-400 ms;
 * 600 ms gives headroom without noticeable latency.
 */
const MEDIA_GROUP_FLUSH_MS = 600;
const TELEGRAM_API_TIMEOUT_MS = 30_000;
const TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS = 30_000;

const BOT_COMMANDS = [
  { command: "new", description: "Create and switch to a new thread" },
  { command: "switch", description: "Switch to an existing thread" },
  { command: "threads", description: "List your threads" },
  { command: "clear", description: "Clear the current thread history" },
  { command: "memory", description: "Show core memory" },
  { command: "log", description: "Show recent activity" },
  { command: "restart", description: "Restart Bryti" },
] as const;

interface TelegramBridgeOptions {
  mode?: "dm" | "group";
  allowedGroups?: number[];
}

interface MediaGroupEntry {
  images: Array<{ data: string; mimeType: string }>;
  caption: string;
  channelId: string;
  userId: string;
  threadId?: string;
  channelThreadId?: string;
  raw: unknown;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Split text into chunks that fit Telegram's message limit.
 * Prefers paragraph boundaries, then newlines, then sentences, then hard cut.
 */
export function chunkMessage(text: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find best split point within the limit
    let splitAt = -1;

    // Try double newline (paragraph boundary)
    const lastPara = remaining.lastIndexOf("\n\n", maxLength);
    if (lastPara > maxLength * 0.3) {
      splitAt = lastPara;
    }

    // Try single newline
    if (splitAt === -1) {
      const lastNl = remaining.lastIndexOf("\n", maxLength);
      if (lastNl > maxLength * 0.3) {
        splitAt = lastNl;
      }
    }

    // Try sentence boundary (. ! ?)
    if (splitAt === -1) {
      const slice = remaining.slice(0, maxLength);
      const sentenceMatch = slice.match(/.*[.!?]\s/s);
      if (sentenceMatch && sentenceMatch[0].length > maxLength * 0.3) {
        splitAt = sentenceMatch[0].length;
      }
    }

    // Hard cut as last resort
    if (splitAt === -1) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Retry helpers
//
// Retry lives here rather than in the caller because the decision of what is
// retryable is Telegram-specific: 429 rate-limits carry a retry_after field,
// 5xx errors warrant exponential backoff, and network failures (ECONNRESET,
// fetch errors, etc.) need to be classified by a Telegram-aware heuristic.
// Pushing this into the bridge keeps all callers simple and ensures consistent
// behavior across sendMessage, editMessage, and sendApprovalRequest.
// ---------------------------------------------------------------------------

/**
 * Retry a Telegram API call with exponential backoff.
 * Retries on 429 rate limits (honours retry_after when present), 5xx server
 * errors, and recoverable network errors. Permanent API errors are re-thrown
 * immediately without consuming retry budget.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = MAX_SEND_RETRIES,
  baseDelay = RETRY_BASE_DELAY_MS,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) break;

      const err = error as Error & {
        error_code?: number;
        parameters?: { retry_after?: number };
      };

      const code = err.error_code;

      // Telegram API rate limit: use retry_after if provided
      if (code === 429) {
        const retryAfter = err.parameters?.retry_after;
        const delayMs = retryAfter ? retryAfter * 1000 : baseDelay * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // Telegram server errors (5xx): exponential backoff
      if (code && code >= 500 && code < 600) {
        await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** attempt));
        continue;
      }

      // Recoverable network errors (ECONNRESET, timeouts, fetch failures, etc.)
      // TODO: the classifier is heuristic (string matching on error codes/messages);
      // a proper connection state machine tracking polling vs. send contexts would
      // give cleaner semantics and fewer false positives.
      if (isRecoverableTelegramNetworkError(error, { context: "send" })) {
        await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** attempt));
        continue;
      }

      // Permanent error — don't retry
      throw error;
    }
  }

  throw lastError;
}

/**
 * Retry a getFile call with exponential backoff.
 * Skips retry for permanent "file is too big" errors.
 */
async function retryGetFile<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) break;
      if (!isRetryableGetFileError(error)) throw error;

      const delayMs = baseDelay * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// TelegramBridge
// ---------------------------------------------------------------------------

/**
 * Telegram bridge implementation.
 */
export class TelegramBridge implements ChannelBridge {
  readonly name = "telegram";
  readonly platform = "telegram" as const;

  private bot: Bot | null = null;
  private handler: MessageHandler | null = null;
  private typingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private readonly allowedUsers: number[];
  private readonly allowedGroups: number[];
  private readonly mode: "dm" | "group";
  /** Pending approval requests: approvalKey → resolve function */
  private pendingApprovals: Map<string, (result: ApprovalResult) => void> = new Map();
  /** Media group buffer: media_group_id → accumulated entry */
  private mediaGroupBuffer: Map<string, MediaGroupEntry> = new Map();

  constructor(
    private readonly botToken: string,
    allowedUsers: number[] = [],
    options: TelegramBridgeOptions = {},
  ) {
    this.allowedUsers = allowedUsers;
    this.allowedGroups = options.allowedGroups ?? [];
    this.mode = options.mode ?? "dm";
  }

  // -------------------------------------------------------------------------
  // Polling lifecycle
  //
  // bot.start() is grammy's long-poll loop. It blocks until bot.stop() is
  // called, so we fire it in the background and attach a .catch() to handle
  // errors. Recoverable network errors (dropped connections, DNS hiccups) are
  // logged as warnings rather than crashing the process; long-polling is
  // inherently fragile over unreliable connections and grammy will restart the
  // loop automatically. Only unexpected errors are promoted to console.error.
  // -------------------------------------------------------------------------
  async start(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Handle text messages (including slash commands).
    // /clear, /memory, /log, /restart are handled by commands.ts in the
    // message processing pipeline. /start and everything else goes to the agent.
    this.bot.on("message:text", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await this.replyUnauthorized(ctx);
        return;
      }

      const text = ctx.message.text;
      if (!text) return;

      if (this.handler) {
        const msg: IncomingMessage = {
          channelId: String(ctx.chat.id),
          userId: String(ctx.from?.id),
          threadId: this.brytiThreadId(ctx),
          channelThreadId: this.channelThreadId(ctx),
          messageId: String(ctx.message.message_id),
          text,
          platform: "telegram",
          raw: ctx.message,
        };
        await this.handler(msg);
      }
    });

    // Handle photo messages — with media group (album) buffering.
    // Telegram sends each photo in an album as a separate update sharing the
    // same media_group_id. We collect them all within MEDIA_GROUP_FLUSH_MS
    // and dispatch a single message containing all images.
    this.bot.on("message:photo", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await this.replyUnauthorized(ctx);
        return;
      }

      if (!this.handler) return;

      const image = await this.downloadPhoto(ctx);
      if (!image) {
        // Only reply if it's not part of an album (avoid spamming for partial failures)
        if (!ctx.message.media_group_id) {
          await ctx.reply("Sorry, I couldn't download that photo.");
        }
        return;
      }

      const caption = ctx.message.caption?.trim() ?? "";
      const channelId = String(ctx.chat.id);
      const userId = String(ctx.from?.id);
      const mediaGroupId = ctx.message.media_group_id;
      const threadId = this.brytiThreadId(ctx);
      const channelThreadId = this.channelThreadId(ctx);

      if (mediaGroupId) {
        // Album: accumulate images and reset the flush timer
        const existing = this.mediaGroupBuffer.get(mediaGroupId);
        if (existing) {
          clearTimeout(existing.timer);
          existing.images.push(...image);
          if (caption && !existing.caption) existing.caption = caption;
          existing.timer = setTimeout(
            () => this.flushMediaGroup(mediaGroupId),
            MEDIA_GROUP_FLUSH_MS,
          );
        } else {
          const entry: MediaGroupEntry = {
            images: [...image],
            caption,
            channelId,
            userId,
            threadId,
            channelThreadId,
            raw: ctx.message,
            timer: setTimeout(
              () => this.flushMediaGroup(mediaGroupId),
              MEDIA_GROUP_FLUSH_MS,
            ),
          };
          this.mediaGroupBuffer.set(mediaGroupId, entry);
        }
        return;
      }

      // Single photo (no album)
      const text = caption || "The user sent this image.";
      const msg: IncomingMessage = {
        channelId,
        userId,
        text,
        threadId,
        channelThreadId,
        platform: "telegram",
        raw: ctx.message,
        images: image,
      };
      await this.handler(msg);
    });

    // Handle Telegram voice notes. Audio is downloaded to a temporary local
    // file and transcribed later by the generic voice service.
    this.bot.on("message:voice", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await this.replyUnauthorized(ctx);
        return;
      }

      if (!this.handler) return;

      const fromId = ctx.from?.id;
      if (fromId == null) return;

      const audio = await this.downloadVoice(ctx);
      if (!audio) {
        await ctx.reply("Sorry, I couldn't download that voice message.");
        return;
      }

      const msg: IncomingMessage = {
        channelId: String(ctx.chat.id),
        userId: String(fromId),
        threadId: this.brytiThreadId(ctx),
        channelThreadId: this.channelThreadId(ctx),
        messageId: String(ctx.message.message_id),
        text: "The user sent a voice message.",
        platform: "telegram",
        raw: ctx.message,
        audio,
        replyMode: "voice",
      };
      await this.handler(msg);
    });

    // Handle document messages that are images (sent as files instead of photos)
    this.bot.on("message:document", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await this.replyUnauthorized(ctx);
        return;
      }

      const doc = ctx.message.document;
      const mimeType = doc.mime_type ?? "";
      if (!mimeType.startsWith("image/")) {
        await ctx.reply("Sorry, I can only handle text messages, images, and voice messages for now.");
        return;
      }

      if (!this.handler) return;

      const images = await this.downloadDocument(ctx, mimeType);
      if (!images) {
        await ctx.reply("Sorry, I couldn't download that image.");
        return;
      }

      const text = ctx.message.caption?.trim() || "The user sent this image.";
      const msg: IncomingMessage = {
        channelId: String(ctx.chat.id),
        userId: String(ctx.from?.id),
        threadId: this.brytiThreadId(ctx),
        channelThreadId: this.channelThreadId(ctx),
        text,
        platform: "telegram",
        raw: ctx.message,
        images,
      };
      await this.handler(msg);
    });

    // Handle unsupported user content. grammy's broad "message" filter also
    // matches text, media handled above, and Telegram service updates such as
    // topic creation. Do not reply to those here.
    this.bot.on("message", async (ctx) => {
      if (this.isHandledOrServiceMessage(ctx)) return;

      if (!this.isAllowed(ctx)) {
        await this.replyUnauthorized(ctx);
        return;
      }
      await ctx.reply("Sorry, I can only handle text messages, images, and voice messages for now.");
    });

    // Handle inline keyboard callbacks for approval requests.
    // Callback data format: "approval:<key>:<result>"
    this.bot.on("callback_query:data", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await ctx.answerCallbackQuery({ text: "Not authorized", show_alert: true });
        return;
      }

      const data = ctx.callbackQuery.data;
      if (!data.startsWith("a:")) {
        await ctx.answerCallbackQuery();
        return;
      }

      // Parse: "a:<shortKey>:<result>" where result is allow|always|deny
      const parts = data.split(":");
      if (parts.length !== 3) {
        await ctx.answerCallbackQuery();
        return;
      }

      const key = parts[1];
      const resultStr = parts[2] === "always" ? "allow_always" as ApprovalResult : parts[2] as ApprovalResult;

      const resolve = this.pendingApprovals.get(key);
      if (resolve) {
        this.pendingApprovals.delete(key);
        resolve(resultStr);
        // Edit the message to remove the buttons and show the result
        const label = resultStr === "allow" ? "✓ Allowed once"
          : resultStr === "allow_always" ? "✓ Always allowed"
          : "✗ Denied";
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
          await ctx.editMessageText(
            (ctx.callbackQuery.message?.text ?? "") + `\n\n<i>${label}</i>`,
            { parse_mode: "HTML" },
          );
        } catch {
          // Message may have been deleted or too old — ignore
        }
      }

      await ctx.answerCallbackQuery();
    });

    // Initialize bot (fetches bot info) then start polling in background
    await this.bot.init();
    await this.registerCommands();
    // bot.start() blocks until stopped; run it in background.
    // Explicitly declare the update types we handle so Telegram doesn't send
    // types we haven't subscribed to (e.g. channel_post, message_reaction).
    this.bot.start({
      allowed_updates: ["message", "callback_query"],
    }).catch((err) => {
      if (isRecoverableTelegramNetworkError(err, { context: "polling" })) {
        console.warn("Telegram polling stopped (network error):", (err as Error).message);
      } else {
        console.error("Telegram polling error:", err);
      }
    });
    console.log("Telegram bridge started (polling mode)");
  }

  private async registerCommands(): Promise<void> {
    if (!this.bot) return;

    try {
      await withTimeout(
        this.bot.api.setMyCommands([...BOT_COMMANDS]),
        TELEGRAM_API_TIMEOUT_MS,
        "Telegram setMyCommands",
      );
    } catch (err) {
      console.warn("Telegram command registration failed:", (err as Error).message);
    }
  }

  async stop(): Promise<void> {
    // Stop all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Cancel any pending media group flush timers
    for (const entry of this.mediaGroupBuffer.values()) {
      clearTimeout(entry.timer);
    }
    this.mediaGroupBuffer.clear();

    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
    console.log("Telegram bridge stopped");
  }

  // -------------------------------------------------------------------------
  // Message sending with retry
  // -------------------------------------------------------------------------
  async sendMessage(channelId: string, text: string, opts?: SendOpts): Promise<string> {
    const bot = await this.requireBot();
    const chatId = parseInt(channelId, 10);

    // Stop typing indicator for this chat
    this.stopTyping(channelId, opts);

    // Always use HTML parse mode. For markdown input, parse into an IR first
    // then chunk at semantic boundaries (never mid-fence or mid-tag), then
    // render each chunk. For pre-formatted HTML, chunk the raw string.
    const chunks =
      opts?.parseMode === "html"
        ? chunkMessage(text)
        : markdownToTelegramChunks(text);

    let lastMessageId = "";
    for (const chunk of chunks) {
      try {
        const message = await withRetry(() =>
          withTimeout(
            bot.api.sendMessage(chatId, chunk, {
              parse_mode: "HTML",
              ...this.telegramThreadOptions(opts),
            }),
            TELEGRAM_API_TIMEOUT_MS,
            "Telegram sendMessage",
          ),
        );
        lastMessageId = String(message.message_id);
      } catch (error) {
        // If HTML parsing fails, fall back to plain text (strip tags)
        const err = error as Error & { error_code?: number; description?: string };
        if (err.error_code === 400 && err.description?.includes("can't parse entities")) {
          console.warn("HTML parse failed, falling back to plain text:", err.description);
          const plain = chunk.replace(/<[^>]+>/g, "");
          const message = await withRetry(() =>
            withTimeout(
              bot.api.sendMessage(chatId, plain, this.telegramThreadOptions(opts)),
              TELEGRAM_API_TIMEOUT_MS,
              "Telegram sendMessage",
            ),
          );
          lastMessageId = String(message.message_id);
        } else {
          throw error;
        }
      }
    }

    return lastMessageId;
  }

  async sendVoice(channelId: string, audioPath: string, opts?: { caption?: string; channelThreadId?: string }): Promise<string> {
    const bot = await this.requireBot();
    const chatId = parseInt(channelId, 10);

    this.stopTyping(channelId, opts);

    const message = await withRetry(() =>
      bot.api.sendVoice(chatId, new InputFile(audioPath), {
        ...(opts?.caption ? { caption: opts.caption } : {}),
        ...this.telegramThreadOptions(opts),
      }),
    );
    return String(message.message_id);
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    const bot = await this.requireBot();
    const chatId = parseInt(channelId, 10);
    const msgId = parseInt(messageId, 10);

    try {
      await withRetry(() =>
        withTimeout(
          bot.api.editMessageText(chatId, msgId, markdownToHtml(text), {
            parse_mode: "HTML",
          }),
          TELEGRAM_API_TIMEOUT_MS,
          "Telegram editMessageText",
        ),
      );
    } catch (error) {
      // Ignore "message is not modified" errors
      const err = error as Error & { description?: string };
      if (!err.description?.includes("message is not modified")) {
        throw error;
      }
    }
  }

  async sendTyping(channelId: string, opts?: SendOpts): Promise<void> {
    // Don't wait for bot during typing, it's cosmetic. Just skip silently.
    if (!this.bot) return;

    const typingKey = this.typingKey(channelId, opts);

    // If already typing, don't start another interval
    if (this.typingIntervals.has(typingKey)) {
      return;
    }

    const chatId = parseInt(channelId, 10);

    // Send initial typing action
    try {
      await withTimeout(
        this.bot.api.sendChatAction(chatId, "typing", this.telegramThreadOptions(opts)),
        TELEGRAM_API_TIMEOUT_MS,
        "Telegram sendChatAction",
      );
    } catch {
      // Ignore errors
    }

    // Keep sending typing indicator every 5 seconds
    const interval = setInterval(async () => {
      try {
        if (this.bot) {
          await withTimeout(
            this.bot.api.sendChatAction(chatId, "typing", this.telegramThreadOptions(opts)),
            TELEGRAM_API_TIMEOUT_MS,
            "Telegram sendChatAction",
          );
        }
      } catch {
        // Stop on error
        this.stopTyping(channelId, opts);
      }
    }, 5000);

    this.typingIntervals.set(typingKey, interval);
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  // -------------------------------------------------------------------------
  // Approval request handling
  //
  // Approval requests are sent as messages with an InlineKeyboard. Each button
  // carries callback data in the format "a:<shortKey>:<result>", where:
  //   - "a:" is a fixed prefix that distinguishes approval callbacks from any
  //     other inline keyboard callbacks the bot may receive in the future.
  //   - shortKey is a 12-character hex prefix of SHA-256(approvalKey). Telegram
  //     limits callback_data to 64 bytes; the full approvalKey (a UUID) would
  //     fit but this keeps room for the prefix and result suffix.
  //   - result is "allow", "always", or "deny".
  //
  // When a button is pressed the callback_query handler looks up shortKey in
  // pendingApprovals, resolves the Promise with the matching ApprovalResult,
  // removes the entry, and edits the message to remove the buttons (so the
  // user can't press them twice).
  // -------------------------------------------------------------------------
  async sendApprovalRequest(
    channelId: string,
    prompt: string,
    approvalKey: string,
    timeoutMs = 5 * 60 * 1000,
    opts?: SendOpts,
  ): Promise<ApprovalResult> {
    const bot = await this.requireBot();

    // Telegram limits callback_query data to 64 bytes. Use a short hash
    // as the callback key and map it back to the full approvalKey internally.
    const shortKey = crypto.createHash("sha256").update(approvalKey).digest("hex").slice(0, 12);

    const keyboard = new InlineKeyboard()
      .text("✓ Allow once", `a:${shortKey}:allow`)
      .text("✓ Always allow", `a:${shortKey}:always`)
      .row()
      .text("✗ Deny", `a:${shortKey}:deny`);

    await withRetry(() =>
      withTimeout(
        bot.api.sendMessage(parseInt(channelId, 10), prompt, {
          parse_mode: "HTML",
          reply_markup: keyboard,
          ...this.telegramThreadOptions(opts),
        }),
        TELEGRAM_API_TIMEOUT_MS,
        "Telegram approval sendMessage",
      ),
    );

    return new Promise<ApprovalResult>((resolve) => {
      this.pendingApprovals.set(shortKey, resolve);

      // Auto-deny on timeout and notify the user
      setTimeout(async () => {
        if (this.pendingApprovals.has(shortKey)) {
          this.pendingApprovals.delete(shortKey);
          resolve("deny");
          try {
            await withRetry(() =>
              withTimeout(
                this.bot!.api.sendMessage(
                  parseInt(channelId, 10),
                  "⏱ Permission request expired (auto-denied).",
                  this.telegramThreadOptions(opts),
                ),
                TELEGRAM_API_TIMEOUT_MS,
                "Telegram approval timeout sendMessage",
              ),
            );
          } catch {
            // Best-effort notification
          }
        }
      }, timeoutMs);
    });
  }

  // -------------------------------------------------------------------------
  // Image downloading
  //
  // Telegram distinguishes two image types:
  //   - Photos: sent through Telegram's compression pipeline, always JPEG,
  //     delivered as an array of pre-scaled sizes (largest last).
  //   - Documents: sent as raw files with the original MIME type preserved.
  //     Used when the sender ticks "send as file" or when the client detects
  //     the image would degrade too much from compression.
  //
  // Both paths call getFile() to obtain a temporary file_path, then fetch the
  // binary over HTTPS from api.telegram.org/file/bot<token>/<file_path>.
  // Telegram's limit is 20 MB per file; getFile() throws with a specific error
  // message for oversized files. isFileTooBigError() catches this before we
  // waste a download attempt. Above the limit Telegram silently truncates the
  // stored file, so the check is load-bearing, not just a nice-to-have.
  // -------------------------------------------------------------------------

  /**
   * Flush a buffered media group (album) as a single message with all images.
   */
  private async flushMediaGroup(mediaGroupId: string): Promise<void> {
    const entry = this.mediaGroupBuffer.get(mediaGroupId);
    if (!entry) return;
    this.mediaGroupBuffer.delete(mediaGroupId);

    if (!this.handler || entry.images.length === 0) return;

    const text = entry.caption || "The user sent this image.";
    const msg: IncomingMessage = {
      channelId: entry.channelId,
      userId: entry.userId,
      threadId: entry.threadId,
      channelThreadId: entry.channelThreadId,
      text,
      platform: "telegram",
      raw: entry.raw,
      images: entry.images,
    };

    console.log(`[telegram] Flushing media group ${mediaGroupId}: ${entry.images.length} image(s)`);
    try {
      await this.handler(msg);
    } catch (err) {
      console.error("[telegram] Media group handler error:", (err as Error).message);
    }
  }

  /**
   * Download the largest available photo from a photo message.
   * Returns a single-element array on success, null on failure.
   */
  private async downloadPhoto(
    ctx: Context & { message: NonNullable<Context["message"]> & { photo: NonNullable<NonNullable<Context["message"]>["photo"]> } },
  ): Promise<Array<{ data: string; mimeType: string }> | null> {
    if (!this.bot) return null;

    // Telegram sends photos as an array of sizes; last entry is largest
    const sizes = ctx.message.photo;
    const largest = sizes[sizes.length - 1];
    if (!largest) return null;

    let filePath: string;
    try {
      const file = await retryGetFile(() => this.bot!.api.getFile(largest.file_id));
      if (!file.file_path) return null;
      filePath = file.file_path;
    } catch (err) {
      if (isFileTooBigError(err)) {
        console.warn(`[telegram] Photo too large to download (>20 MB), skipping`);
      } else {
        console.error("[telegram] getFile failed for photo:", (err as Error).message);
      }
      return null;
    }

    try {
      const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
      const response = await fetchWithTimeout(url, { timeoutMs: TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS });
      if (!response.ok) {
        console.error(`[telegram] Photo download failed: HTTP ${response.status}`);
        return null;
      }

      const buffer = await response.arrayBuffer();
      const data = Buffer.from(buffer).toString("base64");
      // Use Content-Type from response; Telegram serves JPEG for compressed photos,
      // but PNG/WebP for images sent uncompressed. Treat application/octet-stream
      // as unknown (Telegram sometimes returns it for valid images).
      const rawMime = response.headers.get("content-type")?.split(";")[0].trim();
      const mimeType = (!rawMime || rawMime === "application/octet-stream") ? "image/jpeg" : rawMime;
      console.log(
        `[telegram] Downloaded photo: ${buffer.byteLength} bytes ` +
        `(${largest.width}x${largest.height}), mime=${mimeType}`,
      );
      return [{ data, mimeType }];
    } catch (err) {
      console.error("[telegram] Photo fetch failed:", (err as Error).message);
      return null;
    }
  }

  /**
   * Download a Telegram voice note to a local temporary file.
   */
  private async downloadVoice(
    ctx: Context & { message: NonNullable<Context["message"]> & { voice: NonNullable<NonNullable<Context["message"]>["voice"]> } },
  ): Promise<AudioAttachment[] | null> {
    if (!this.bot) return null;

    const voice = ctx.message.voice;
    let filePath: string;
    try {
      const file = await retryGetFile(() => this.bot!.api.getFile(voice.file_id));
      if (!file.file_path) return null;
      filePath = file.file_path;
    } catch (err) {
      if (isFileTooBigError(err)) {
        console.warn("[telegram] Voice message too large to download (>20 MB), skipping");
      } else {
        console.error("[telegram] getFile failed for voice:", (err as Error).message);
      }
      return null;
    }

    let dirPath = "";
    let localPath = "";
    try {
      const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[telegram] Voice download failed: HTTP ${response.status}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      dirPath = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-telegram-voice-"));
      const remoteName = path.basename(filePath) || `${voice.file_unique_id}.ogg`;
      const localName = path.extname(remoteName) ? remoteName : `${remoteName}.ogg`;
      localPath = path.join(dirPath, localName);
      fs.writeFileSync(localPath, buffer);

      const rawMime = response.headers.get("content-type")?.split(";")[0].trim();
      const mimeType = voice.mime_type || rawMime || "audio/ogg";
      console.log(`[telegram] Downloaded voice message: ${buffer.byteLength} bytes, mime=${mimeType}`);
      return [{
        path: localPath,
        mimeType,
        fileName: localName,
        durationSeconds: voice.duration,
      }];
    } catch (err) {
      if (localPath) {
        try {
          fs.rmSync(localPath, { force: true });
        } catch {}
      }
      if (dirPath) {
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
        } catch {}
      }
      console.error("[telegram] Voice fetch failed:", (err as Error).message);
      return null;
    }
  }

  /**
   * Download an image document (sent as a file rather than a compressed photo).
   * Returns a single-element array on success, null on failure.
   */
  private async downloadDocument(
    ctx: Context & { message: NonNullable<Context["message"]> & { document: NonNullable<NonNullable<Context["message"]>["document"]> } },
    mimeType: string,
  ): Promise<Array<{ data: string; mimeType: string }> | null> {
    if (!this.bot) return null;

    const doc = ctx.message.document;
    let filePath: string;
    try {
      const file = await retryGetFile(() => this.bot!.api.getFile(doc.file_id));
      if (!file.file_path) return null;
      filePath = file.file_path;
    } catch (err) {
      if (isFileTooBigError(err)) {
        console.warn(`[telegram] Image document too large to download (>20 MB), skipping`);
      } else {
        console.error("[telegram] getFile failed for document:", (err as Error).message);
      }
      return null;
    }

    try {
      const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
      const response = await fetchWithTimeout(url, { timeoutMs: TELEGRAM_FILE_DOWNLOAD_TIMEOUT_MS });
      if (!response.ok) {
        console.error(`[telegram] Document download failed: HTTP ${response.status}`);
        return null;
      }

      const buffer = await response.arrayBuffer();
      const data = Buffer.from(buffer).toString("base64");
      // Trust the declared MIME type for documents; fall back to response header
      const resolvedMime =
        mimeType || response.headers.get("content-type")?.split(";")[0].trim() || "image/jpeg";
      console.log(`[telegram] Downloaded image document: ${buffer.byteLength} bytes, mime=${resolvedMime}`);
      return [{ data, mimeType: resolvedMime }];
    } catch (err) {
      console.error("[telegram] Document fetch failed:", (err as Error).message);
      return null;
    }
  }

  /**
   * Wait for the bot to be available. During restart cycles the bot may
   * briefly be null between stop() and start(). Waits up to 10s.
   */
  private async requireBot(): Promise<Bot> {
    if (this.bot) return this.bot;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (this.bot) return this.bot;
    }
    throw new Error("Bot not started");
  }

  private channelThreadId(ctx: Context): string | undefined {
    const threadId = (ctx.message as { message_thread_id?: number } | undefined)?.message_thread_id;
    return threadId == null ? undefined : String(threadId);
  }

  private brytiThreadId(ctx: Context): string | undefined {
    if (this.mode !== "group") return undefined;
    if (ctx.chat?.type === "private") return undefined;
    const chatId = ctx.chat?.id;
    if (chatId == null) return undefined;
    const topicId = this.channelThreadId(ctx);
    return topicId ? `telegram-topic-${Math.abs(chatId)}-${topicId}` : `telegram-chat-${Math.abs(chatId)}`;
  }

  private telegramThreadOptions(opts?: SendOpts): { message_thread_id?: number } {
    const threadId = opts?.channelThreadId ? Number(opts.channelThreadId) : undefined;
    return Number.isSafeInteger(threadId) ? { message_thread_id: threadId } : {};
  }

  private typingKey(channelId: string, opts?: SendOpts): string {
    return opts?.channelThreadId ? `${channelId}:${opts.channelThreadId}` : channelId;
  }

  private isHandledOrServiceMessage(ctx: Context): boolean {
    const message = ctx.message as Record<string, unknown> | undefined;
    if (!message) return true;

    const handledKeys = ["text", "photo", "voice", "document"];
    if (handledKeys.some((key) => key in message)) return true;

    const serviceKeys = [
      "forum_topic_created",
      "forum_topic_edited",
      "forum_topic_closed",
      "forum_topic_reopened",
      "general_forum_topic_hidden",
      "general_forum_topic_unhidden",
      "new_chat_members",
      "left_chat_member",
      "pinned_message",
      "message_auto_delete_timer_changed",
      "migrate_to_chat_id",
      "migrate_from_chat_id",
      "group_chat_created",
      "supergroup_chat_created",
      "channel_chat_created",
    ];
    return serviceKeys.some((key) => key in message);
  }

  private async replyUnauthorized(ctx: Context): Promise<void> {
    if (ctx.chat?.type === "private") {
      await ctx.reply("Sorry, you're not authorized to use this bot.");
    }
  }

  private logGroupAuth(ctx: Context, allowed: boolean, reason: string): void {
    if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") return;
    console.log(
      `[telegram] group message ${allowed ? "accepted" : "rejected"}: ` +
      `reason=${reason} chat=${ctx.chat.id} from=${ctx.from?.id ?? "none"} ` +
      `thread=${this.channelThreadId(ctx) ?? "none"}`,
    );
  }

  /**
   * Check if user is allowed to use the bot.
   * When allowed_users is empty, nobody is allowed (deny by default).
   */
  private isAllowed(ctx: Context): boolean {
    const userId = ctx.from?.id;
    if (!userId) {
      this.logGroupAuth(ctx, false, "missing_from");
      return false;
    }
    if (!this.allowedUsers.includes(userId)) {
      this.logGroupAuth(ctx, false, "user_not_allowed");
      return false;
    }

    const chat = ctx.chat;
    if (!chat) return false;

    if (chat.type === "private") {
      return true;
    }

    if (this.mode === "dm") {
      this.logGroupAuth(ctx, false, "dm_mode_group");
      return false;
    }

    const allowed = this.allowedGroups.includes(chat.id);
    this.logGroupAuth(ctx, allowed, allowed ? "group_allowed" : "group_not_allowed");
    return allowed;
  }

  /**
   * Stop typing indicator for a channel.
   */
  private stopTyping(channelId: string, opts?: SendOpts): void {
    const typingKey = this.typingKey(channelId, opts);
    const interval = this.typingIntervals.get(typingKey);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(typingKey);
    }
  }
}
