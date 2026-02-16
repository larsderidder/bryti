/**
 * Telegram bridge using grammy.
 *
 * Implements ChannelBridge for Telegram DMs.
 * Long polling for local dev, webhook for production (later).
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
 * Escape text for Markdown V2.
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`")
    .replace(/>/g, "\\>")
    .replace(/#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/=/g, "\\=")
    .replace(/-/g, "\\-")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\|/g, "\\|")
    .replace(/\./g, "\\.")
    .replace(/!/g, "\\!");
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

    // Start polling
    await this.bot.start();
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
    let parseMode: "MarkdownV2" | "HTML" | undefined;

    if (opts?.parseMode === "markdown") {
      parseMode = "MarkdownV2";
    }

    // Stop typing indicator for this chat
    this.stopTyping(channelId);

    const message = await this.bot.api.sendMessage(chatId, text, {
      parse_mode: parseMode,
    });

    return String(message.message_id);
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not started");
    }

    const chatId = parseInt(channelId, 10);
    const msgId = parseInt(messageId, 10);

    try {
      await this.bot.api.editMessageText(chatId, msgId, text, {
        parse_mode: "MarkdownV2",
      });
    } catch (error) {
      // Ignore message not modified errors
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
