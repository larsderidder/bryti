/**
 * Telegram bridge using grammy.
 *
 * Implements ChannelBridge for Telegram DMs.
 * Long polling for local dev, webhook for production (later).
 *
 * Formatting: all outgoing messages use HTML parse mode. LLM output (markdown)
 * is converted with markdownToHtml() before sending. HTML is far simpler to
 * produce correctly than MarkdownV2, which requires escaping 18 characters and
 * is easily broken by LLM output.
 */

import { Bot, InlineKeyboard, type Context } from "grammy";
import type { ApprovalResult, ChannelBridge, IncomingMessage, SendOpts } from "./types.js";
import { markdownToIR, chunkMarkdownIR, type MarkdownLinkSpan } from "../markdown/ir.js";
import { renderMarkdownWithMarkers } from "../markdown/render.js";

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
 * Convert LLM markdown output to Telegram HTML using a proper markdown IR.
 *
 * Uses markdown-it to parse, then renders to Telegram-compatible HTML tags:
 * - Bold (**text**) -> <b>text</b>
 * - Italic (*text*) -> <i>text</i>
 * - Strikethrough (~~text~~) -> <s>text</s>
 * - Inline code (`...`) -> <code>...</code>
 * - Code blocks (```...```) -> <pre><code>...</code></pre>
 * - Headings -> <b>text</b> (Telegram has no heading tags)
 * - Links -> <a href="...">text</a>
 * - Tables -> bullet list format (Telegram has no table support)
 */
export function markdownToHtml(text: string): string {
  const ir = markdownToIR(text ?? "", TELEGRAM_IR_OPTIONS);
  return renderMarkdownWithMarkers(ir, TELEGRAM_RENDER_OPTIONS);
}

/**
 * Parse markdown into an IR, split at semantic boundaries (never mid-fence),
 * and render each chunk to Telegram HTML.
 *
 * This is the safe way to chunk large responses: splitting after IR parsing
 * means code blocks, bold spans, and links are never cut in half.
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
 * Split text into chunks that fit within Telegram's message limit.
 *
 * Strategy: split on double newlines (paragraphs) first, then single newlines,
 * then sentence boundaries, then hard-cut at the limit. Tries to keep code
 * blocks intact when possible.
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
 * Respects Telegram's retry_after header on 429 responses.
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

      // Only retry on rate limits (429) and server errors (5xx)
      const code = err.error_code;
      if (code && code !== 429 && (code < 500 || code >= 600)) {
        throw error;
      }

      // Use Telegram's retry_after if provided, otherwise exponential backoff
      const retryAfter = err.parameters?.retry_after;
      const delayMs = retryAfter
        ? retryAfter * 1000
        : baseDelay * 2 ** attempt;

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

    // Handle photo messages
    this.bot.on("message:photo", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await ctx.reply("Sorry, you're not authorized to use this bot.");
        return;
      }

      if (!this.handler) return;

      const images = await this.downloadPhoto(ctx);
      if (!images) {
        await ctx.reply("Sorry, I couldn't download that photo.");
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
      if (!data.startsWith("approval:")) {
        await ctx.answerCallbackQuery();
        return;
      }

      // Parse: "approval:<key>:<result>"
      const rest = data.slice("approval:".length);
      const lastColon = rest.lastIndexOf(":");
      if (lastColon === -1) {
        await ctx.answerCallbackQuery();
        return;
      }

      const key = rest.slice(0, lastColon);
      const resultStr = rest.slice(lastColon + 1) as ApprovalResult;

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
    // bot.start() blocks until stopped; run it in background
    this.bot.start().catch((err) => {
      console.error("Telegram polling error:", err);
    });
    console.log("Telegram bridge started (polling mode)");
  }

  async stop(): Promise<void> {
    // Stop all typing intervals
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

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

    const keyboard = new InlineKeyboard()
      .text("✓ Allow once", `approval:${approvalKey}:allow`)
      .text("✓ Always allow", `approval:${approvalKey}:allow_always`)
      .row()
      .text("✗ Deny", `approval:${approvalKey}:deny`);

    await withRetry(() =>
      this.bot!.api.sendMessage(parseInt(channelId, 10), escapeHtml(prompt), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }),
    );

    return new Promise<ApprovalResult>((resolve) => {
      this.pendingApprovals.set(approvalKey, resolve);

      // Auto-deny on timeout
      setTimeout(() => {
        if (this.pendingApprovals.has(approvalKey)) {
          this.pendingApprovals.delete(approvalKey);
          resolve("deny");
        }
      }, timeoutMs);
    });
  }

  /**
   * Download the largest available photo from a photo message and return it
   * as a base64-encoded image attachment. Returns null on failure.
   */
  private async downloadPhoto(
    ctx: Context & { message: NonNullable<Context["message"]> & { photo: NonNullable<NonNullable<Context["message"]>["photo"]> } },
  ): Promise<Array<{ data: string; mimeType: string }> | null> {
    if (!this.bot) return null;

    // Telegram sends photos as an array of sizes; last entry is largest
    const sizes = ctx.message.photo;
    console.log(`[telegram] Photo sizes: ${sizes.map((s) => `${s.width}x${s.height} (file_size: ${s.file_size ?? "?"})`).join(", ")}`);
    const largest = sizes[sizes.length - 1];
    if (!largest) return null;

    try {
      const file = await this.bot.api.getFile(largest.file_id);
      if (!file.file_path) return null;

      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) return null;

      const buffer = await response.arrayBuffer();
      const data = Buffer.from(buffer).toString("base64");
      // Use Content-Type from response; fall back to JPEG (Telegram default for compressed photos)
      const mimeType = response.headers.get("content-type")?.split(";")[0].trim() || "image/jpeg";
      console.log(`[telegram] Downloaded photo: ${buffer.byteLength} bytes (${largest.width}x${largest.height}), mime=${mimeType}, base64 length ${data.length}`);
      return [{ data, mimeType }];
    } catch (err) {
      console.error("[telegram] Failed to download photo:", (err as Error).message);
      return null;
    }
  }

  /**
   * Download an image document and return it as a base64-encoded attachment.
   * Returns null on failure.
   */
  private async downloadDocument(
    ctx: Context & { message: NonNullable<Context["message"]> & { document: NonNullable<NonNullable<Context["message"]>["document"]> } },
    mimeType: string,
  ): Promise<Array<{ data: string; mimeType: string }> | null> {
    if (!this.bot) return null;

    const doc = ctx.message.document;
    try {
      const file = await this.bot.api.getFile(doc.file_id);
      if (!file.file_path) return null;

      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) return null;

      const buffer = await response.arrayBuffer();
      const data = Buffer.from(buffer).toString("base64");
      return [{ data, mimeType }];
    } catch (err) {
      console.error("[telegram] Failed to download document:", (err as Error).message);
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
