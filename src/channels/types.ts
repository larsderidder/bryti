/**
 * Channel bridge interface.
 *
 * Abstracts messaging platforms. Telegram first, then Discord, Slack, Matrix.
 * Each platform has different threading models:
 * - Telegram: flat DM chat (v1), forum topics (later)
 * - WhatsApp: flat DM chat via baileys (no Meta Business API)
 * - Discord: DM channel (v1), server threads (later)
 * - Slack: DM (v1), channel threads (later)
 * - Matrix: room per user
 */

export type Platform = "telegram" | "whatsapp" | "discord" | "slack" | "matrix";

export interface IncomingMessage {
  /** Platform-specific chat/channel/room ID */
  channelId: string;
  /** Platform-specific user ID */
  userId: string;
  /** Message text content */
  text: string;
  /** Which platform this came from */
  platform: Platform;
  /** Platform-specific raw message object */
  raw: unknown;
  /** Image attachments (base64-encoded, vision-capable models only). */
  images?: Array<{ data: string; mimeType: string }>;
}

export interface SendOpts {
  parseMode?: "markdown" | "html" | "plain";
}

export interface ChannelBridge {
  readonly name: string;
  readonly platform: Platform;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Send a message, returns a message ID that can be used for edits. */
  sendMessage(channelId: string, text: string, opts?: SendOpts): Promise<string>;

  /** Edit a previously sent message (for streaming updates). */
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;

  /** Show typing indicator. */
  sendTyping(channelId: string): Promise<void>;

  /** Register a handler for incoming messages. */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
}
