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

import { Bot, type Context } from "grammy";
import type { ChannelBridge, IncomingMessage, SendOpts } from "./types.js";

/**
 * Telegram message handler function.
 */
type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * Telegram bridge configuration.
 */
export interface TelegramBridgeConfig {
  botToken: string;
  allowedUsers: number[];
}

/**
 * Escape the three HTML special characters that Telegram HTML mode requires.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert common LLM markdown output to Telegram HTML.
 *
 * Handles:
 * - Fenced code blocks (```lang\n...\n```) -> <pre><code>...</code></pre>
 * - Inline code (`...`) -> <code>...</code>
 * - Bold (**text** or __text__) -> <b>text</b>
 * - Italic (*text* or _text_) -> <i>text</i>
 * - Strikethrough (~~text~~) -> <s>text</s>
 * - ATX headings (# / ## / ###) -> <b>text</b> (Telegram has no heading tag)
 * - Horizontal rules (--- / ***) -> stripped
 * - Everything else: HTML-escaped plain text
 *
 * Strategy: HTML-escape the whole segment first, then apply markdown patterns
 * against the already-escaped text. Markdown delimiters (**,  *, __, _, ~~,
 * `) are ASCII and unaffected by HTML escaping, so the patterns still match
 * correctly. Code content is escaped before wrapping.
 *
 * Code blocks are extracted first so their contents skip inline processing.
 */
export function markdownToHtml(text: string): string {
  // Split on fenced code blocks; odd-indexed parts are code blocks.
  const parts = text.split(/(```[\s\S]*?```)/g);

  const converted = parts.map((part, i) => {
    if (i % 2 === 1) {
      // Fenced code block
      const match = part.match(/^```\w*\n?([\s\S]*?)```$/);
      const code = match ? match[1] : part.replace(/^```\w*\n?|```$/g, "");
      return `<pre><code>${escapeHtml(code)}</code></pre>`;
    }

    // Non-code segment: escape HTML first (so plain text is safe), then apply
    // markdown patterns. Delimiters (**, *, __, _, ~~, `) are ASCII and survive
    // HTML escaping unchanged, so patterns still match correctly.
    // Process line by line so heading/hr detection works on full lines.
    const lines = part.split("\n").map((line) => {
      const escaped = escapeHtml(line);

      // ATX headings — strip the hashes, bold the rest
      const headingMatch = escaped.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch) {
        return `<b>${headingMatch[1]}</b>`;
      }

      // Horizontal rules
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
        return "";
      }

      return escaped;
    });

    return lines
      .join("\n")
      // Inline code
      .replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
      // Strikethrough
      .replace(/~~([^~]+)~~/g, (_m, t) => `<s>${t}</s>`)
      // Bold (** or __)
      .replace(/\*\*([^*]+)\*\*/g, (_m, t) => `<b>${t}</b>`)
      .replace(/__([^_]+)__/g, (_m, t) => `<b>${t}</b>`)
      // Italic (* or _) — single, must not be preceded/followed by same char
      .replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, (_m, t) => `<i>${t}</i>`)
      .replace(/(?<!_)_(?!_)([^_]+)(?<!_)_(?!_)/g, (_m, t) => `<i>${t}</i>`);
  });

  return converted.join("").trim();
}

/** Telegram's maximum message length in characters. */
const MAX_MESSAGE_LENGTH = 4096;

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
        "Welcome to Pibot! I'm your personal AI assistant.\n\n" +
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

    // Handle non-text messages
    this.bot.on("message", async (ctx) => {
      if (!this.isAllowed(ctx)) {
        await ctx.reply("Sorry, you're not authorized to use this bot.");
        return;
      }
      await ctx.reply("Sorry, I can only handle text messages for now.");
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

    // Always use HTML parse mode. Convert markdown from LLM output unless the
    // caller explicitly passes pre-formatted HTML or plain text.
    const html = opts?.parseMode === "html" ? text : markdownToHtml(text);

    // Split into chunks if the message exceeds Telegram's limit
    const chunks = chunkMessage(html);

    let lastMessageId = "";
    for (const chunk of chunks) {
      const message = await withRetry(() =>
        bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" }),
      );
      lastMessageId = String(message.message_id);
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
