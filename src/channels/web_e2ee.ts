// src/channels/web_e2ee.ts
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadOrCreateServerKeyPair } from "../web-e2ee/server-key-store.js";
import { createDeviceStore } from "../web-e2ee/device-store.js";
import { createInviteStore } from "../web-e2ee/invite-store.js";
import {
  assertValidPublicX25519Jwk,
  generateDeviceId,
  importPublicKeyJwk,
  fingerprintPublicKey,
} from "../web-e2ee/crypto.js";
import { WebE2EEHttpServer } from "../web-e2ee/http-server.js";
import { WebE2EEWsServer } from "../web-e2ee/ws-server.js";
import {
  WEB_E2EE_MAX_AUDIO_BYTES,
  type DecryptedMessageEvent,
  type PairingCompleteRequest,
  type WebE2EEAudioMimeType,
} from "../web-e2ee/protocol.js";
import { deliveryNotSent, deliveryUnknown, isDeliveryError } from "./delivery.js";
import type { ApprovalResult, AudioAttachment, ChannelBridge, IncomingMessage, SendOpts } from "./types.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

const AUDIO_EXTENSION_BY_MIME: Record<WebE2EEAudioMimeType, string> = {
  "audio/webm": ".webm",
  "audio/webm;codecs=opus": ".webm",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
};
const WEB_E2EE_VOICE_PLACEHOLDER = "The user sent a voice message.";
const MAX_CLIENT_FILENAME_LENGTH = 120;
const AUDIO_MIME_BY_EXTENSION = new Map<string, WebE2EEAudioMimeType>([
  [".ogg", "audio/ogg"],
  [".opus", "audio/opus"],
  [".webm", "audio/webm"],
]);

function ensureIncomingAudioDir(dataDir: string): string {
  const dir = path.join(dataDir, "files", "voice");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeClientFileName(fileName: string | undefined): string | undefined {
  if (typeof fileName !== "string") {
    return undefined;
  }
  const normalized = fileName.normalize("NFKC");
  const trimmed = normalized.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) {
    return undefined;
  }
  const stripped = trimmed
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-z0-9._ ()+-]/g, "_")
    .trim();
  if (!stripped || stripped === "." || stripped === "..") {
    return undefined;
  }
  return stripped.slice(0, MAX_CLIENT_FILENAME_LENGTH);
}

function decodeAudioBase64(dataBase64: string): Buffer {
  if (!dataBase64 || dataBase64.length === 0) {
    throw new Error("Encrypted audio payload is empty");
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length <= 0) {
    throw new Error("Encrypted audio payload is empty");
  }
  if (bytes.length > WEB_E2EE_MAX_AUDIO_BYTES) {
    throw new Error(`Encrypted audio payload exceeds ${WEB_E2EE_MAX_AUDIO_BYTES} bytes`);
  }
  return bytes;
}

function writeIncomingAudioAttachment(
  dataDir: string,
  payload: Extract<DecryptedMessageEvent["payload"], { kind: "audio" }>,
): AudioAttachment {
  const ext = AUDIO_EXTENSION_BY_MIME[payload.mimeType];
  const dir = ensureIncomingAudioDir(dataDir);
  const filePath = path.join(dir, `web-e2ee-${Date.now()}-${randomUUID()}${ext}`);
  const bytes = decodeAudioBase64(payload.dataBase64);
  fs.writeFileSync(filePath, bytes);
  return {
    path: filePath,
    mimeType: payload.mimeType,
    fileName: sanitizeClientFileName(payload.fileName),
    durationSeconds: payload.durationSeconds,
  };
}

function getOutgoingAudioMimeType(audioPath: string): WebE2EEAudioMimeType {
  const ext = path.extname(audioPath).toLowerCase();
  const mimeType = AUDIO_MIME_BY_EXTENSION.get(ext);
  if (!mimeType) {
    throw new Error(`Unsupported web_e2ee voice reply extension: ${ext || "(none)"}`);
  }
  return mimeType;
}

function readOutgoingAudioFile(audioPath: string): Buffer {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(audioPath);
  } catch {
    throw new Error(`web_e2ee voice reply file is missing: ${audioPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`web_e2ee voice reply path is not a file: ${audioPath}`);
  }
  if (stat.size <= 0) {
    throw new Error("web_e2ee voice reply file is empty");
  }
  if (stat.size > WEB_E2EE_MAX_AUDIO_BYTES) {
    throw new Error(`web_e2ee voice reply exceeds ${WEB_E2EE_MAX_AUDIO_BYTES} bytes`);
  }
  return fs.readFileSync(audioPath);
}


function classifyWebE2EEDeliveryError(error: unknown): Error {
  if (isDeliveryError(error)) {
    return error;
  }

  let message = String(error);
  if (error instanceof Error) {
    message = error.message;
  }

  if (message.startsWith("web_e2ee device is offline:")) {
    return deliveryNotSent(message, { retryable: true, cause: error });
  }
  if (message.startsWith("Unknown web_e2ee device:")) {
    return deliveryNotSent(message, { retryable: false, cause: error });
  }
  if (message.startsWith("web_e2ee device is not active:")) {
    return deliveryNotSent(message, { retryable: false, cause: error });
  }
  if (message === "web_e2ee bridge not started" || message === "web_e2ee websocket server not started") {
    return deliveryNotSent(message, { retryable: true, cause: error });
  }
  if (message.startsWith("Unsupported web_e2ee voice reply extension:")) {
    return deliveryNotSent(message, { retryable: false, cause: error });
  }
  if (message.startsWith("web_e2ee voice reply file is missing:")) {
    return deliveryNotSent(message, { retryable: false, cause: error });
  }
  if (message === "web_e2ee voice reply path is not a file") {
    return deliveryNotSent(message, { retryable: false, cause: error });
  }
  if (message === "web_e2ee voice reply file is empty") {
    return deliveryNotSent(message, { retryable: false, cause: error });
  }
  if (message.startsWith("web_e2ee voice reply exceeds")) {
    return deliveryNotSent(message, { retryable: false, cause: error });
  }

  return deliveryUnknown(message, { cause: error });
}

function mapDecryptedEventToIncomingMessage(dataDir: string, event: DecryptedMessageEvent): IncomingMessage {
  if (event.payload.kind === "text") {
    return {
      channelId: event.deviceId,
      userId: event.deviceId,
      messageId: event.messageId,
      text: event.payload.text,
      platform: "web_e2ee",
      raw: event.raw,
    };
  }

  return {
    channelId: event.deviceId,
    userId: event.deviceId,
    messageId: event.messageId,
    text: WEB_E2EE_VOICE_PLACEHOLDER,
    platform: "web_e2ee",
    raw: event.raw,
    audio: [writeIncomingAudioAttachment(dataDir, event.payload)],
    replyMode: "voice",
  };
}

/**
 * Self-hosted web_e2ee channel bridge.
 */
export class WebE2EEBridge implements ChannelBridge {
  readonly name = "web_e2ee";
  readonly platform = "web_e2ee" as const;

  private handler: MessageHandler | null = null;
  private started = false;
  private httpServer: WebE2EEHttpServer | null = null;
  private wsServer: WebE2EEWsServer | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly config: {
      listen_host: string;
      listen_port: number;
      public_origin: string;
      allowed_origins: string[];
      path_prefix: string;
      pairing: { invite_ttl_minutes: number };
    },
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const serverKeys = await loadOrCreateServerKeyPair(this.dataDir);
    const deviceStore = createDeviceStore(this.dataDir);
    const inviteStore = createInviteStore(this.dataDir);

    const httpServer = new WebE2EEHttpServer({
      listenHost: this.config.listen_host,
      listenPort: this.config.listen_port,
      publicOrigin: this.config.public_origin,
      pathPrefix: this.config.path_prefix,
      serverInfo: {
        channel: "web_e2ee",
        protocolVersion: 1,
        designVersion: "slice7b-browser-audio-input",
        serverPublicFingerprint: serverKeys.fingerprint,
        pathPrefix: this.config.path_prefix,
        pairingEnabled: this.config.pairing.invite_ttl_minutes > 0,
        encryptedTransport: true,
        chatEnabled: true,
      },
      completePairing: async (request: PairingCompleteRequest) => {
        assertValidPublicX25519Jwk(request.publicKeyJwk);
        const publicKey = await importPublicKeyJwk(request.publicKeyJwk);
        const publicKeyFingerprint = await fingerprintPublicKey(publicKey);
        if (deviceStore.list().some((device) => device.publicKeyFingerprint === publicKeyFingerprint)) {
          throw new Error(`Device public key already registered: ${publicKeyFingerprint}`);
        }
        const deviceId = generateDeviceId();

        await inviteStore.consume(request.code, deviceId);
        await deviceStore.add({
          deviceId,
          label: request.label,
          publicKeyJwk: request.publicKeyJwk,
          publicKeyFingerprint,
          pairedAt: new Date().toISOString(),
          lastSeenAt: null,
          status: "active",
          notes: "",
          lastInboundCounter: 0,
          lastOutboundCounter: 0,
        });

        return {
          deviceId,
          serverPublicKeyJwk: serverKeys.publicKeyJwk,
          serverPublicFingerprint: serverKeys.fingerprint,
          protocolVersion: 1,
          pathPrefix: this.config.path_prefix,
        };
      },
    });

    await httpServer.start();

    let wsServer: WebE2EEWsServer;
    try {
      wsServer = new WebE2EEWsServer(httpServer.getHttpServer(), {
        pathPrefix: this.config.path_prefix,
        allowedOrigins: this.config.allowed_origins,
        deviceStore,
        serverKeys,
        onDecryptedMessage: async (event) => {
          if (!this.handler) {
            return;
          }
          await this.handler(mapDecryptedEventToIncomingMessage(this.dataDir, event));
        },
      });
    } catch (error) {
      await httpServer.stop();
      throw error;
    }

    this.httpServer = httpServer;
    this.wsServer = wsServer;
    this.started = true;

    console.log(
      `[web_e2ee] Transport shell started on ${this.config.listen_host}:${this.config.listen_port} ` +
      `(server fingerprint ${serverKeys.fingerprint})`,
    );
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    const wsServer = this.wsServer;
    const httpServer = this.httpServer;
    this.wsServer = null;
    this.httpServer = null;

    if (wsServer && httpServer) {
      wsServer.detachFrom(httpServer.getHttpServer());
      await wsServer.stop();
      await httpServer.stop();
    }

    this.started = false;
    console.log("[web_e2ee] Transport shell stopped");
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendMessage(channelId: string, text: string, _opts?: SendOpts): Promise<string> {
    try {
      this.assertStarted();
      if (!this.wsServer) {
        throw new Error("web_e2ee websocket server not started");
      }
      return await this.wsServer.sendEncryptedText(channelId, text);
    } catch (error) {
      throw classifyWebE2EEDeliveryError(error);
    }
  }

  async sendVoice(channelId: string, audioPath: string, _opts?: { caption?: string }): Promise<string> {
    try {
      this.assertStarted();
      if (!this.wsServer) {
        throw new Error("web_e2ee websocket server not started");
      }

      const mimeType = getOutgoingAudioMimeType(audioPath);
      const bytes = readOutgoingAudioFile(audioPath);
      return await this.wsServer.sendEncryptedPayload(channelId, {
        kind: "audio",
        mimeType,
        dataBase64: bytes.toString("base64"),
        fileName: path.basename(audioPath),
      });
    } catch (error) {
      throw classifyWebE2EEDeliveryError(error);
    }
  }

  async editMessage(_channelId: string, _messageId: string, _text: string): Promise<void> {
    this.assertStarted();
    throw new Error("web_e2ee.editMessage is not implemented yet (transport shell only)");
  }

  async sendTyping(_channelId: string): Promise<void> {
    this.assertStarted();
  }

  async sendApprovalRequest(
    _channelId: string,
    _prompt: string,
    _approvalKey: string,
    _timeoutMs?: number,
  ): Promise<ApprovalResult> {
    this.assertStarted();
    throw new Error("web_e2ee.sendApprovalRequest is not implemented yet (transport shell only)");
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error("web_e2ee bridge not started");
    }
  }
}
