/**
 * WhatsApp bridge using baileys.
 *
 * Implements ChannelBridge for WhatsApp DMs.
 * QR code auth on first run, then persistent multi-file auth state.
 * Auto-reconnects on disconnect with exponential backoff.
 *
 * Formatting: WhatsApp supports *bold*, _italic_, ~strikethrough~, ```code```.
 * We convert basic markdown patterns. No HTML support.
 */

import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  type WASocket,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import type { ApprovalResult, ChannelBridge, IncomingMessage, SendOpts } from "./types.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

// WhatsApp message limit (chars). Actual limit is ~65536 but long messages
// are unreadable. Split at a practical limit.
const MAX_MESSAGE_LENGTH = 4000;

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
  /** Pending text-based approvals: approvalKey → resolve */
  private pendingApprovals: Map<string, (result: ApprovalResult) => void> = new Map();

  /**
   * @param dataDir Base data directory (auth state stored in dataDir/whatsapp-auth/)
   * @param allowedUsers Phone numbers in international format without +, e.g. ["31612345678"]
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

    const silentLogger = {
      level: "silent",
      info: () => {},
      warn: () => {},
      error: (...args: unknown[]) => console.error("[whatsapp:baileys]", ...args),
      debug: () => {},
      trace: () => {},
      fatal: (...args: unknown[]) => console.error("[whatsapp:baileys:fatal]", ...args),
      child: () => silentLogger,
    };

    this.socket = makeWASocket({
      auth: state,
      browser: ["Bryti", "Chrome", "22.0"],
      logger: silentLogger as any,
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

    this.socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        // Only handle personal DMs (not groups, broadcasts, status)
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith("@s.whatsapp.net")) continue;

        // Skip our own messages
        if (msg.key.fromMe) continue;

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

        // Check allowed users (if configured)
        if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(phoneNumber)) {
          console.log(`[whatsapp] Ignoring message from non-allowed user: ${phoneNumber}`);
          continue;
        }

        // Download image attachment if present
        let images: Array<{ data: string; mimeType: string }> | undefined;
        if (isImageMessage && this.socket) {
          try {
            const buf = await downloadMediaMessage(msg, "buffer", {});
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

    // Wait for the connection to open. No timeout — QR scanning + the initial
    // WhatsApp sync can take a while on a phone. The promise resolves as soon
    // as the connection is "open", or if the socket closes without ever
    // connecting (e.g. loggedOut), in which case startup continues anyway
    // and the reconnect logic takes over.
    await new Promise<void>((resolve) => {
      const onUpdate = (update: { connection?: string }) => {
        if (update.connection === "open" || update.connection === "close") {
          this.socket?.ev.off("connection.update", onUpdate);
          resolve();
        }
      };
      // If already open (shouldn't happen on first connect but just in case)
      if (this.connectionState === "open") {
        resolve();
        return;
      }
      this.socket!.ev.on("connection.update", onUpdate);
    });
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
      throw new Error("WhatsApp not connected");
    }

    const formatted = formatForWhatsApp(text);
    const chunks = chunkText(formatted, MAX_MESSAGE_LENGTH);

    let lastMessageId = "";
    for (const chunk of chunks) {
      const sent = await this.socket.sendMessage(channelId, { text: chunk });
      lastMessageId = sent?.key?.id ?? "";

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
      await this.socket.sendPresenceUpdate("composing", channelId);
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
    await this.sendMessage(
      channelId,
      `${prompt}\n\nReply *YES* to allow once, *ALWAYS* to always allow, or *NO* to deny.`,
    );

    return new Promise<ApprovalResult>((resolve) => {
      this.pendingApprovals.set(approvalKey, resolve);

      setTimeout(() => {
        if (this.pendingApprovals.has(approvalKey)) {
          this.pendingApprovals.delete(approvalKey);
          resolve("deny");
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
    const [key, resolve] = this.pendingApprovals.entries().next().value as [string, (r: ApprovalResult) => void];
    this.pendingApprovals.delete(key);
    resolve(result);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Convert markdown-ish text to WhatsApp formatting.
 *
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```code```, `inline code`
 * We do minimal conversion since the LLM output is already close to what
 * WhatsApp expects.
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
