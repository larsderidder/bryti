/**
 * WhatsApp bridge using baileys.
 *
 * Implements ChannelBridge for WhatsApp DMs.
 * QR code auth for first run, then persistent auth state.
 */

import makeWASocket, {
  type ConnectionState,
  useMultiFileAuthState,
  type WASocket,
  proto,
} from "@whiskeysockets/baileys";
import type { WASocket as WASocketType } from "@whiskeysockets/baileys";
import * as qrcodeTerminal from "qrcode-terminal";
import type { ChannelBridge, IncomingMessage, SendOpts } from "./types.js";

/**
 * WhatsApp message handler function.
 */
type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * WhatsApp bridge configuration.
 */
export interface WhatsAppBridgeConfig {
  dataDir: string;
}

/**
 * WhatsApp bridge implementation.
 */
export class WhatsAppBridge implements ChannelBridge {
  readonly name = "whatsapp";
  readonly platform = "whatsapp" as const;

  private socket: WASocket | null = null;
  private handler: MessageHandler | null = null;
  private readonly dataDir: string;
  private connectionState: "open" | "connecting" | "close" = "close";

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async start(): Promise<void> {
    const authDir = `${this.dataDir}/whatsapp-auth`;

    // Load auth state from files
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Create the socket
    this.socket = makeWASocket({
      auth: state,
      printQRInTerminal: false, // We handle QR manually
      browser: ["Pibot", "Chrome", "120"],
    });

    // Handle credentials save
    this.socket.ev.on("creds.update", saveCreds);

    // Handle connection updates
    this.socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Display QR code in terminal
        console.log("\n📱 WhatsApp Authentication QR Code:");
        qrcodeTerminal.generate(qr, { small: true });
        console.log("Scan this QR code with your WhatsApp app\n");
      }

      if (connection) {
        this.connectionState = connection;
        if (connection === "open") {
          console.log("WhatsApp bridge connected!");
        } else if (connection === "close") {
          const reason = (lastDisconnect?.error as Error)?.message;
          console.log(`WhatsApp disconnected: ${reason}`);
        }
      }
    });

    // Handle incoming messages
    this.socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        // Skip group messages
        if (!msg.key.remoteJid?.endsWith("@s.whatsapp.net")) continue;

        // Skip our own messages
        if (msg.key.fromMe) continue;

        // Skip messages without text
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
        if (!text) continue;

        if (this.handler) {
          const incomingMsg: IncomingMessage = {
            channelId: msg.key.remoteJid!,
            userId: msg.key.participant!,
            text,
            platform: "whatsapp",
            raw: msg,
          };
          await this.handler(incomingMsg);
        }
      }
    });

    // Wait for connection to open
    await new Promise<void>((resolve) => {
      const checkConnection = () => {
        if (this.connectionState === "open") {
          resolve();
        } else if (this.connectionState === "close") {
          resolve(); // Resolve anyway to not block startup
        } else {
          setTimeout(checkConnection, 100);
        }
      };
      checkConnection();
    });
  }

  async stop(): Promise<void> {
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
    console.log("WhatsApp bridge stopped");
  }

  async sendMessage(channelId: string, text: string, _opts?: SendOpts): Promise<string> {
    if (!this.socket) {
      throw new Error("WhatsApp not connected");
    }

    // Convert markdown-like formatting to WhatsApp format
    const formattedText = this.formatText(text);

    const message = await this.socket.sendMessage(channelId, {
      text: formattedText,
    });

    if (!message?.key?.id) {
      throw new Error("Failed to send message");
    }

    // Return message ID
    return message.key.id;
  }

  async editMessage(_channelId: string, _messageId: string, _text: string): Promise<void> {
    // WhatsApp doesn't support message editing
    throw new Error("WhatsApp does not support message editing");
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.socket) {
      throw new Error("WhatsApp not connected");
    }

    // Use presenceSubscribe and sendPresenceUpdate instead
    await this.socket.sendPresenceUpdate("composing", channelId);
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /**
   * Convert markdown-like formatting to WhatsApp format.
   */
  private formatText(text: string): string {
    // WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```code```
    // Our Telegram bridge sends MarkdownV2, so convert back
    let formatted = text;

    // Unescape markdown (Telegram bridge escapes these)
    formatted = formatted.replace(/\\\*/g, "*");
    formatted = formatted.replace(/\\_/g, "_");
    formatted = formatted.replace(/\\~/g, "~");
    formatted = formatted.replace(/\\`/g, "`");
    formatted = formatted.replace(/\\#/g, "#");

    return formatted;
  }
}
