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

import crypto from "node:crypto";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { ApprovalResult, ChannelBridge, IncomingMessage, SendOpts } from "./types.js";
import { markdownToIR, chunkMarkdownIR, type MarkdownLinkSpan } from "../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../markdown/render.js";
import {
  isRecoverableTelegramNetworkError,
  isRetryableGetFileError,
  isFileTooBigError,
} from "./telegram-network-errors.js";

/**
 * Telegram message handler function.
 */
type MessageHandler = (msg: IncomingMessage) => Promise<void>;


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

interface MediaGroupEntry {
  images: Array<{ data: string; mimeType: string }>;
  caption: string;
  channelId: string;
  userId: string;
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

/**
 * Retry a Telegram API call with exponential backoff.
 * Retries on 429 (using retry_after), 5xx, and recoverable network errors.
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
  /** Pending approval requests: approvalKey → resolve function */
  private pendingApprovals: Map<string, (result: ApprovalResult) => void> = new Map();
  /** Media group buffer: media_group_id → accumulated entry */
  private mediaGroupBuffer: Map<string, MediaGroupEntry> = new Map();

  constructor(private readonly botToken: string, allowedUsers: number[] = []) {
    this.allowedUsers = allowedUsers;
  }

  async start(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Handle /start command
    this.bot.command("start", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await ctx.reply("Sorry, you're not authorized to use this bot.");
        return;
      }
      await ctx.reply(
        "Welcome to Bryti! I'm your personal AI assistant.\n\n" +
        "Commands:\n" +
        "/start - Show this message\n" +
        "/clear - Clear conversation history\n" +
        "/memory - Show your persistent memory\n" +
        "/help - Show available commands",
      );
    });

    // Handle /help command
    this.bot.command("help", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await ctx.reply("Sorry, you're not authorized to use this bot.");
        return;
      }
      await ctx.reply(
        "I can help you with:\n" +
        "- Web search and information lookup\n" +
        "- Reading and writing files\n" +
        "- Remembering important information\n\n" +
        "Just send me a message and I'll help you!",
      );
    });

    // Handle /clear command - handled by the message handler
    this.bot.command("clear", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await ctx.reply("Sorry, you're not authorized to use this bot.");
        return;
      }
      // Signal to handler that this is a clear command
      if (this.handler && ctx.message) {
        const msg: IncomingMessage = {
          channelId: String(ctx.chat.id),
          userId: String(ctx.from?.id),
          text: "/clear",
          platform: "telegram",
          raw: ctx.message,
        };
        await this.handler(msg);
        await ctx.reply("Conversation history cleared.");
      }
    });

    // Handle /memory command
    this.bot.command("memory", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await ctx.reply("Sorry, you're not authorized to use this bot.");
        return;
      }
      // Signal to handler that this is a memory command
      if (this.handler && ctx.message) {
        const msg: IncomingMessage = {
          channelId: String(ctx.chat.id),
          userId: String(ctx.from?.id),
          text: "/memory",
          platform: "telegram",
          raw: ctx.message,
        };
        await this.handler(msg);
      }
    });

    // Handle text messages
    this.bot.on("message:text", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await ctx.reply("Sorry, you're not authorized to use this bot.");
        return;
      }

      const text = ctx.message.text;
      if (!text || text.startsWith("/")) {
        return; // Skip commands (handled above)
      }

      if (this.handler) {
        const msg: IncomingMessage = {
          channelId: String(ctx.chat.id),
          userId: String(ctx.from?.id),
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
        await ctx.reply("Sorry, you're not authorized to use this bot.");
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
        platform: "telegram",
        raw: ctx.message,
        images: image,
      };
      await this.handler(msg);
    });

    // Handle document messages that are images (sent as files instead of photos)
    this.bot.on("message:document", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await ctx.reply("Sorry, you're not authorized to use this bot.");
        return;
      }

      const doc = ctx.message.document;
      const mimeType = doc.mime_type ?? "";
      if (!mimeType.startsWith("image/")) {
        await ctx.reply("Sorry, I can only handle text messages and images for now.");
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
        text,
        platform: "telegram",
        raw: ctx.message,
        images,
      };
      await this.handler(msg);
    });

    // Handle non-text messages
    this.bot.on("message", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await ctx.reply("Sorry, you're not authorized to use this bot.");
        return;
      }
      await ctx.reply("Sorry, I can only handle text messages and images for now.");
    });

    // Handle inline keyboard callbacks for approval requests.
    // Callback data format: "approval:<key>:<result>"
    this.bot.on("callback_query:data", async (ctx) => {
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

  async sendMessage(channelId: string, text: string, opts?: SendOpts): Promise<string> {
    if (!this.bot) {
      throw new Error("Bot not started");
    }

    const chatId = parseInt(channelId, 10);
    const bot = this.bot;

    // Stop typing indicator for this chat
    this.stopTyping(channelId);

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
          bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" }),
        );
        lastMessageId = String(message.message_id);
      } catch (error) {
        // If HTML parsing fails, fall back to plain text (strip tags)
        const err = error as Error & { error_code?: number; description?: string };
        if (err.error_code === 400 && err.description?.includes("can't parse entities")) {
          console.warn("HTML parse failed, falling back to plain text:", err.description);
          const plain = chunk.replace(/<[^>]+>/g, "");
          const message = await withRetry(() =>
            bot.api.sendMessage(chatId, plain),
          );
          lastMessageId = String(message.message_id);
        } else {
          throw error;
        }
      }
    }

    return lastMessageId;
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not started");
    }

    const chatId = parseInt(channelId, 10);
    const msgId = parseInt(messageId, 10);
    const bot = this.bot;

    try {
      await withRetry(() =>
        bot.api.editMessageText(chatId, msgId, markdownToHtml(text), {
          parse_mode: "HTML",
        }),
      );
    } catch (error) {
      // Ignore "message is not modified" errors
      const err = error as Error & { description?: string };
      if (!err.description?.includes("message is not modified")) {
        throw error;
      }
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not started");
    }

    // If already typing, don't start another interval
    if (this.typingIntervals.has(channelId)) {
      return;
    }

    const chatId = parseInt(channelId, 10);

    // Send initial typing action
    try {
      await this.bot.api.sendChatAction(chatId, "typing");
    } catch {
      // Ignore errors
    }

    // Keep sending typing indicator every 5 seconds
    const interval = setInterval(async () => {
      try {
        if (this.bot) {
          await this.bot.api.sendChatAction(chatId, "typing");
        }
      } catch {
        // Stop on error
        this.stopTyping(channelId);
      }
    }, 5000);

    this.typingIntervals.set(channelId, interval);
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendApprovalRequest(
    channelId: string,
    prompt: string,
    approvalKey: string,
    timeoutMs = 5 * 60 * 1000,
  ): Promise<ApprovalResult> {
    if (!this.bot) throw new Error("Bot not started");

    // Telegram limits callback_query data to 64 bytes. Use a short hash
    // as the callback key and map it back to the full approvalKey internally.
    const shortKey = crypto.createHash("sha256").update(approvalKey).digest("hex").slice(0, 12);

    const keyboard = new InlineKeyboard()
      .text("✓ Allow once", `a:${shortKey}:allow`)
      .text("✓ Always allow", `a:${shortKey}:always`)
      .row()
      .text("✗ Deny", `a:${shortKey}:deny`);

    await withRetry(() =>
      this.bot!.api.sendMessage(parseInt(channelId, 10), prompt, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }),
    );

    return new Promise<ApprovalResult>((resolve) => {
      this.pendingApprovals.set(shortKey, resolve);

      // Auto-deny on timeout
      setTimeout(() => {
        if (this.pendingApprovals.has(shortKey)) {
          this.pendingApprovals.delete(shortKey);
          resolve("deny");
        }
      }, timeoutMs);
    });
  }

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
      const response = await fetch(url);
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
      const response = await fetch(url);
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
   * Check if user is allowed to use the bot.
   */
  private isAllowed(ctx: Context): boolean {
    // If no allowed users specified, allow all
    if (this.allowedUsers.length === 0) {
      return true;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      return false;
    }

    return this.allowedUsers.includes(userId);
  }

  /**
   * Stop typing indicator for a channel.
   */
  private stopTyping(channelId: string): void {
    const interval = this.typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(channelId);
    }
  }
}
