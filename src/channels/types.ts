/**
 * Channel bridge interface.
 *
 * Abstracts messaging platforms behind a common send/receive API.
 * Currently: Telegram (flat DMs) and WhatsApp (baileys, no Meta Business API).
 * Planned: Discord, Slack, Matrix.
 */

export type Platform = "telegram" | "whatsapp" | "web_e2ee" | "discord" | "slack" | "matrix";

export interface AudioAttachment {
  /** Local filesystem path to the downloaded audio file. */
  path: string;
  /** MIME type, e.g. audio/ogg. */
  mimeType: string;
  /** Original platform filename when available. */
  fileName?: string;
  /** Audio duration when provided by the platform. */
  durationSeconds?: number;
}

export type ReplyMode = "text" | "voice";

export interface IncomingMessage {
  /** Platform-specific chat/channel/room ID */
  channelId: string;
  /** Platform-specific user ID */
  userId: string;
  /** Platform-specific message ID when available. */
  messageId?: string;
  /** Message text content */
  text: string;
  /** Which platform this came from */
  platform: Platform;
  /** Platform-specific raw message object */
  raw: unknown;
  /** Image attachments (base64-encoded, vision-capable models only). */
  images?: Array<{ data: string; mimeType: string }>;
  /** Audio attachments downloaded to local temporary files. */
  audio?: AudioAttachment[];
  /** Preferred response mode for this message. */
  replyMode?: ReplyMode;
}

export interface SendOpts {
  parseMode?: "markdown" | "html" | "plain";
}

/**
 * Result of an inline approval request.
 * - allow: approved for this invocation only
 * - allow_always: approved permanently (persisted to disk)
 * - deny: rejected
 */
export type ApprovalResult = "allow" | "allow_always" | "deny";

export interface ChannelBridge {
  readonly name: string;
  readonly platform: Platform;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Send a message, returns a message ID that can be used for edits. */
  sendMessage(channelId: string, text: string, opts?: SendOpts): Promise<string>;

  /** Edit a previously sent message (for streaming updates). */
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;

  /** Send a voice/audio message when the channel supports it. */
  sendVoice?(channelId: string, audioPath: string, opts?: { caption?: string }): Promise<string>;

  /** Show typing indicator. */
  sendTyping(channelId: string): Promise<void>;

  /** Register a handler for incoming messages. */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;

  /**
   * Send an approval request with inline buttons and wait for the user's response.
   *
   * @param channelId  Chat to send the approval prompt to.
   * @param prompt     Human-readable description of what needs approval.
   * @param approvalKey Unique key for this request (used to match callback).
   * @param timeoutMs  How long to wait before auto-denying (default: 5 minutes).
   */
  sendApprovalRequest(
    channelId: string,
    prompt: string,
    approvalKey: string,
    timeoutMs?: number,
  ): Promise<ApprovalResult>;
}
