/**
 * WhatsApp bridge using baileys.
 *
 * ChannelBridge for WhatsApp DMs. QR code auth on first run, persistent
 * multi-file auth state after that. Auto-reconnects on disconnect with
 * exponential backoff up to 10 attempts.
 *
 * WhatsApp supports *bold*, _italic_, ~strikethrough~, and ```code```.
 * We convert basic markdown patterns; no HTML.
 */

import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  type WASocket,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import type { ILogger } from "@whiskeysockets/baileys/lib/Utils/logger.js";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import { deliveryNotSent, deliveryUnknown, isDeliveryError } from "./delivery.js";
import type { ApprovalResult, ChannelBridge, IncomingMessage, SendOpts } from "./types.js";
import { withTimeout } from "../util/timeout.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;
type PendingApproval = { resolve: (result: ApprovalResult) => void; messageId?: string };
type BaileysReaction = { key?: { id?: unknown }; text?: unknown };
type BaileysReactionEvent = { reaction?: BaileysReaction; message?: { reactionMessage?: BaileysReaction } };
type ReactionEmitter = { on(event: "messages.reaction", listener: (reactions: unknown[]) => void): void };

// WhatsApp message limit (chars). Actual limit is ~65536 but long messages
// are unreadable. Split at a practical limit.
const MAX_MESSAGE_LENGTH = 4000;
const WHATSAPP_CONNECT_TIMEOUT_MS = 60_000;
const WHATSAPP_SEND_TIMEOUT_MS = 30_000;
const WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;


function classifyWhatsAppSendError(error: unknown): Error {
  if (isDeliveryError(error)) {
    return error;
  }
  if (error instanceof Error) {
    return deliveryUnknown(error.message, { cause: error });
  }
  return deliveryUnknown(String(error), { cause: error });
}

export class WhatsAppBridge implements ChannelBridge {
  readonly name = "whatsapp";
  readonly platform = "whatsapp" as const;

  private socket: WASocket | null = null;
  private handler: MessageHandler | null = null;
  private readonly dataDir: string;
  private readonly allowedUsers: string[];
  private connectionState: "open" | "connecting" | "close" = "close";
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  /** Pending approvals keyed by the trust approval id. */
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private approvalByMessageId: Map<string, string> = new Map();

  /**
   * @param dataDir Base data directory (auth state stored in dataDir/whatsapp-auth/)
   * @param allowedUsers Phone numbers in international format without +, for example ["31612345678"]
   */
  constructor(dataDir: string, allowedUsers: string[] = []) {
    this.dataDir = dataDir;
    // Normalize: strip + prefix, ensure @s.whatsapp.net suffix for comparison
    this.allowedUsers = allowedUsers.map((u) => u.replace(/^\+/, ""));
  }

  async start(): Promise<void> {
    this.shouldReconnect = true;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const authDir = `${this.dataDir}/whatsapp-auth`;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const silentLogger: ILogger = {
      level: "silent",
      info: () => {},
      warn: () => {},
      error: (obj: unknown, msg?: string) => console.error("[whatsapp:baileys]", msg ?? obj),
      debug: () => {},
      trace: () => {},
      child: () => silentLogger,
    };

    this.socket = makeWASocket({
      auth: state,
      browser: ["Bryti", "Chrome", "22.0"],
      logger: silentLogger,
    });

    this.socket.ev.on("creds.update", saveCreds);

    this.socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcode.generate(qr, { small: true });
        console.log("[whatsapp] Scan the QR code with your WhatsApp app");
      }

      if (connection === "open") {
        this.connectionState = "open";
        this.reconnectAttempts = 0;
        console.log("[whatsapp] Connected");
      } else if (connection === "close") {
        this.connectionState = "close";
        const boom = lastDisconnect?.error as Boom | undefined;
        const statusCode = boom?.output?.statusCode;
        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut && this.shouldReconnect;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("[whatsapp] Logged out. Delete whatsapp-auth/ and restart to re-authenticate.");
        } else if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
          console.log(
            `[whatsapp] Disconnected (${boom?.message ?? "unknown"}). ` +
            `Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
          );
          setTimeout(() => this.connect().catch(console.error), delay);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          console.error("[whatsapp] Max reconnect attempts reached. Giving up.");
        }
      }
    });

    (this.socket.ev as ReactionEmitter).on("messages.reaction", (reactions: unknown[]) => {
      for (const reaction of reactions) {
        this.handleReactionApproval(reaction);
      }
    });

    this.socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        // Only handle personal DMs (not groups, broadcasts, status)
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith("@s.whatsapp.net")) continue;

        // Skip our own messages
        if (msg.key.fromMe) continue;

        if (this.handleReactionApproval(msg)) {
          continue;
        }

        // Extract text from various message types
        const isImageMessage = !!msg.message?.imageMessage;
        const text =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          msg.message?.imageMessage?.caption ??
          msg.message?.videoMessage?.caption ??
          (isImageMessage ? "The user sent this image." : undefined);
        if (!text) continue;

        // Extract phone number from JID (strip @s.whatsapp.net)
        const phoneNumber = jid.replace("@s.whatsapp.net", "");

        // Check allowed users (empty list = deny all, same as Telegram)
        if (this.allowedUsers.length === 0 || !this.allowedUsers.includes(phoneNumber)) {
          console.log(`[whatsapp] Ignoring message from non-allowed user: ${phoneNumber}`);
          continue;
        }

        // Download image attachment if present
        let images: Array<{ data: string; mimeType: string }> | undefined;
        if (isImageMessage && this.socket) {
          try {
            const buf = await withTimeout(
              downloadMediaMessage(msg, "buffer", {}),
              WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS,
              "WhatsApp media download",
            );
            const mimeType = msg.message?.imageMessage?.mimetype ?? "image/jpeg";
            images = [{ data: buf.toString("base64"), mimeType }];
          } catch (err) {
            console.error("[whatsapp] Failed to download image:", (err as Error).message);
          }
        }

        // Check if this message is a response to a pending approval request
        if (this.checkApprovalResponse(text)) {
          continue;
        }

        if (this.handler) {
          const incomingMsg: IncomingMessage = {
            channelId: jid,
            userId: phoneNumber,
            text,
            platform: "whatsapp",
            raw: msg,
            images,
          };
          try {
            await this.handler(incomingMsg);
          } catch (err) {
            console.error("[whatsapp] Handler error:", (err as Error).message);
          }
        }
      }
    });

    // Wait for the connection to open, but do not let startup hang forever.
    // QR scanning can take a while, so timeout only logs and lets reconnect
    // logic continue in the background.
    try {
      await withTimeout(
        new Promise<void>((resolve) => {
          const onUpdate = (update: { connection?: string }) => {
            if (update.connection === "open" || update.connection === "close") {
              this.socket?.ev.off("connection.update", onUpdate);
              resolve();
            }
          };
          if (this.connectionState === "open") {
            resolve();
            return;
          }
          this.socket?.ev.on("connection.update", onUpdate);
        }),
        WHATSAPP_CONNECT_TIMEOUT_MS,
        "WhatsApp connect",
      );
    } catch (error) {
      console.warn(`[whatsapp] Initial connection wait timed out: ${(error as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false;
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
    console.log("[whatsapp] Stopped");
  }

  async sendMessage(channelId: string, text: string, _opts?: SendOpts): Promise<string> {
    if (!this.socket || this.connectionState !== "open") {
      throw deliveryNotSent("WhatsApp not connected", { retryable: true });
    }

    const formatted = formatForWhatsApp(text);
    const chunks = chunkText(formatted, MAX_MESSAGE_LENGTH);

    let lastMessageId = "";
    for (const chunk of chunks) {
      try {
        const sent = await withTimeout(
          this.socket.sendMessage(channelId, { text: chunk }),
          WHATSAPP_SEND_TIMEOUT_MS,
          "WhatsApp sendMessage",
        );
        lastMessageId = sent?.key?.id ?? "";
      } catch (error) {
        throw classifyWhatsAppSendError(error);
      }

      // Small delay between chunks to avoid rate limiting
      if (chunks.length > 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    return lastMessageId;
  }

  async editMessage(_channelId: string, _messageId: string, _text: string): Promise<void> {
    // WhatsApp doesn't support message editing via baileys
    // Could send a new message with "correction:" prefix, but that's noisy
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.socket || this.connectionState !== "open") return;
    try {
      await withTimeout(
        this.socket.sendPresenceUpdate("composing", channelId),
        WHATSAPP_SEND_TIMEOUT_MS,
        "WhatsApp sendPresenceUpdate",
      );
    } catch {
      // Best-effort typing indicator
    }
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
    // WhatsApp has no inline buttons for non-Business accounts.
    // Fall back to text instructions; parse the next message from this user.
    const messageId = await this.sendMessage(
      channelId,
      `${prompt}\n\nReply *YES* to allow once, *ALWAYS* to always allow, or *NO* to deny. React 👍 to allow once, ⭐ to always allow, or 👎 to deny.`,
    );

    return new Promise<ApprovalResult>((resolve) => {
      this.pendingApprovals.set(approvalKey, { resolve, messageId });
      if (messageId) this.approvalByMessageId.set(messageId, approvalKey);

      setTimeout(async () => {
        if (this.pendingApprovals.has(approvalKey)) {
          const pending = this.pendingApprovals.get(approvalKey);
          this.pendingApprovals.delete(approvalKey);
          if (pending?.messageId) this.approvalByMessageId.delete(pending.messageId);
          resolve("deny");
          try {
            await this.sendMessage(channelId, "Permission request expired (auto-denied).");
          } catch {
            // Best-effort notification
          }
        }
      }, timeoutMs);
    });
  }

  /**
   * Check if an incoming message is a response to a pending approval.
   * Called from the message handler before passing to the main handler.
   * Returns true if the message was consumed as an approval response.
   */
  checkApprovalResponse(text: string): boolean {
    if (this.pendingApprovals.size === 0) return false;

    const lower = text.trim().toLowerCase();
    let result: ApprovalResult | null = null;
    if (lower === "yes" || lower === "allow") result = "allow";
    else if (lower === "always" || lower === "always allow") result = "allow_always";
    else if (lower === "no" || lower === "deny") result = "deny";
    else return false;

    // Resolve the oldest pending approval
    const [key, pending] = this.pendingApprovals.entries().next().value as [string, PendingApproval];
    this.resolveApproval(key, pending, result);
    return true;
  }

  private handleReactionApproval(raw: unknown): boolean {
    const event = raw as BaileysReactionEvent;
    const reaction = event.reaction ?? event.message?.reactionMessage;
    const targetId = reaction?.key?.id;
    if (!targetId || typeof targetId !== "string") return false;

    const approvalKey = this.approvalByMessageId.get(targetId);
    if (!approvalKey) return false;

    const pending = this.pendingApprovals.get(approvalKey);
    if (!pending) return false;

    const emoji = String(reaction.text ?? "").trim();
    let result: ApprovalResult | null = null;
    if (["👍", "✅"].includes(emoji)) result = "allow";
    else if (["⭐", "🌟", "❤️", "❤"].includes(emoji)) result = "allow_always";
    else if (["👎", "❌", "🚫"].includes(emoji)) result = "deny";
    if (!result) return false;

    this.resolveApproval(approvalKey, pending, result);
    return true;
  }

  private resolveApproval(
    approvalKey: string,
    pending: PendingApproval,
    result: ApprovalResult,
  ): void {
    this.pendingApprovals.delete(approvalKey);
    if (pending.messageId) this.approvalByMessageId.delete(pending.messageId);
    pending.resolve(result);
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Convert markdown to WhatsApp formatting. Minimal conversion since LLM
 * output is already close to what WhatsApp expects.
 */
function formatForWhatsApp(text: string): string {
  let result = text;

  // Convert **bold** to *bold* (WhatsApp uses single asterisks)
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Convert ### headers to *bold* lines (WhatsApp has no header support)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // HTML entities that might leak through
  result = result.replace(/&amp;/g, "&");
  result = result.replace(/&lt;/g, "<");
  result = result.replace(/&gt;/g, ">");

  return result;
}

/**
 * Split text into chunks at paragraph boundaries.
 */
function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to split at a double newline (paragraph boundary)
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt < maxLength * 0.3) {
      // No good paragraph break, try single newline
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }
    if (splitAt < maxLength * 0.3) {
      // No good newline, hard split at space
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt < maxLength * 0.3) {
      // Nothing works, hard split
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
