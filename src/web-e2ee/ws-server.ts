import type http from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { DeviceStore } from "./device-store.js";
import {
  decryptPayload,
  deriveDirectionalAesKeys,
  encryptPayload,
  exportRawPublicKey,
  generateMessageId,
  generateMessageNonce,
  importPublicKeyJwk,
  publicKeyJwkToRawBytes,
} from "./crypto.js";
import { bytesToBase64Url } from "./encoding.js";
import { normalizePathPrefix, prefixedPath } from "./path-utils.js";
import {
  assertValidEncryptedBindPayload,
  assertValidEncryptedFrame,
  assertValidEncryptedTextPayload,
  canonicalFrameHeader,
  type DecryptedTextMessageEvent,
} from "./protocol.js";
import type { LoadedServerKeyPair } from "./types.js";

export interface WebE2EEWsServerOptions {
  pathPrefix: string;
  allowedOrigins: string[];
  deviceStore: DeviceStore;
  serverKeys: LoadedServerKeyPair;
  onDecryptedMessage?: (event: DecryptedTextMessageEvent) => Promise<void> | void;
}

interface BasicFrame {
  kind?: unknown;
}

export class WebE2EEWsServer {
  private readonly pathPrefix: string;
  private readonly endpointPath: string;
  private readonly allowedOrigins: Set<string>;
  private readonly wss: WebSocketServer;
  private readonly upgradeHandler: (req: http.IncomingMessage, socket: Socket, head: Buffer) => void;
  private readonly boundSockets = new Map<string, WebSocket>();
  private readonly socketBindings = new WeakMap<WebSocket, string>();

  constructor(server: http.Server, private readonly options: WebE2EEWsServerOptions) {
    this.pathPrefix = normalizePathPrefix(options.pathPrefix);
    this.endpointPath = prefixedPath(this.pathPrefix, "/ws");
    this.allowedOrigins = new Set(options.allowedOrigins);
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on("connection", (socket) => {
      this.sendJson(socket, {
        kind: "hello",
        channel: "web_e2ee",
        encrypted: true,
        chat: true,
      });
      socket.on("message", (data) => {
        void this.handleMessage(socket, data);
      });
      socket.on("close", () => {
        this.unbindSocket(socket);
      });
    });

    this.upgradeHandler = (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== this.endpointPath) {
        socket.destroy();
        return;
      }

      const origin = req.headers.origin;
      if (origin && !this.allowedOrigins.has(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    };

    server.on("upgrade", this.upgradeHandler);
  }

  getEndpointPath(): string {
    return this.endpointPath;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) {
      client.close(1001, "server stopping");
    }
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  detachFrom(server: http.Server): void {
    server.off("upgrade", this.upgradeHandler);
  }

  private async handleMessage(socket: WebSocket, data: RawData): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(String(data));
    } catch {
      this.sendJson(socket, { kind: "error", code: "invalid_json" });
      return;
    }

    const basic = frame as BasicFrame;
    switch (basic.kind) {
      case "ping":
        this.sendJson(socket, { kind: "pong", channel: "web_e2ee" });
        return;
      case "status":
        this.sendJson(socket, {
          kind: "status",
          channel: "web_e2ee",
          encrypted: true,
          chat: true,
        });
        return;
      case "msg":
      case "bind":
        await this.handleEncryptedFrame(socket, frame);
        return;
      default:
        this.sendJson(socket, { kind: "error", code: "invalid_frame" });
        return;
    }
  }

  async sendEncryptedText(deviceId: string, text: string): Promise<string> {
    const device = this.options.deviceStore.get(deviceId);
    if (!device) {
      throw new Error(`Unknown web_e2ee device: ${deviceId}`);
    }
    if (device.status !== "active") {
      throw new Error(`web_e2ee device is not active: ${deviceId}`);
    }

    const socket = this.boundSockets.get(deviceId);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error(`web_e2ee device is offline: ${deviceId}`);
    }

    const nextCounter = device.lastOutboundCounter + 1;
    const ts = new Date().toISOString();
    this.options.deviceStore.updateLastOutboundCounter(deviceId, nextCounter, ts);

    const devicePublicKey = await importPublicKeyJwk(device.publicKeyJwk);
    const serverPublicKeyRaw = await exportRawPublicKey(this.options.serverKeys.publicKey);
    const devicePublicKeyRaw = publicKeyJwkToRawBytes(device.publicKeyJwk);
    const { s2cKey } = await deriveDirectionalAesKeys(
      this.options.serverKeys.privateKey,
      devicePublicKey,
      serverPublicKeyRaw,
      devicePublicKeyRaw,
    );
    const payload = assertValidEncryptedTextPayload({ kind: "text", text });
    const frame = {
      v: 1 as const,
      kind: "msg" as const,
      deviceId,
      messageId: generateMessageId(),
      counter: nextCounter,
      ts,
      nonce: bytesToBase64Url(generateMessageNonce()),
    };
    const ciphertext = await encryptPayload(s2cKey, frame, payload);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.send(JSON.stringify({ ...frame, ciphertext }), (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    } catch {
      this.unbindSocket(socket);
      try {
        socket.close(1011, "send failed");
      } catch {
        // ignore close failures
      }
      throw new Error(`Failed to deliver web_e2ee message to device: ${deviceId}`);
    }

    return frame.messageId;
  }

  private async handleEncryptedFrame(socket: WebSocket, frameValue: unknown): Promise<void> {
    let frame;
    try {
      frame = assertValidEncryptedFrame(frameValue);
    } catch {
      this.sendJson(socket, { kind: "error", code: "invalid_frame" });
      return;
    }

    const device = this.options.deviceStore.get(frame.deviceId);
    if (!device) {
      this.sendJson(socket, { kind: "error", code: "unknown_device" });
      return;
    }
    if (device.status !== "active") {
      this.sendJson(socket, { kind: "error", code: "revoked_device" });
      return;
    }
    if (frame.counter <= device.lastInboundCounter) {
      this.sendJson(socket, { kind: "error", code: "replay_detected" });
      return;
    }

    let decrypted: unknown;
    try {
      const devicePublicKey = await importPublicKeyJwk(device.publicKeyJwk);
      const serverPublicKeyRaw = await exportRawPublicKey(this.options.serverKeys.publicKey);
      const devicePublicKeyRaw = publicKeyJwkToRawBytes(device.publicKeyJwk);
      const { c2sKey } = await deriveDirectionalAesKeys(
        this.options.serverKeys.privateKey,
        devicePublicKey,
        serverPublicKeyRaw,
        devicePublicKeyRaw,
      );
      decrypted = await decryptPayload(c2sKey, canonicalFrameHeader(frame), frame.ciphertext);
    } catch {
      this.sendJson(socket, { kind: "error", code: "decrypt_failed" });
      return;
    }

    let payload: ReturnType<typeof assertValidEncryptedTextPayload> | null = null;
    try {
      if (frame.kind === "bind") {
        assertValidEncryptedBindPayload(decrypted);
      } else {
        payload = assertValidEncryptedTextPayload(decrypted);
      }
      this.bindSocket(frame.deviceId, socket);
      this.options.deviceStore.updateLastInboundCounter(frame.deviceId, frame.counter, new Date().toISOString());
    } catch {
      this.sendJson(socket, { kind: "error", code: "decrypt_failed" });
      return;
    }

    if (frame.kind === "bind") {
      return;
    }
    if (!payload) {
      this.sendJson(socket, { kind: "error", code: "decrypt_failed" });
      return;
    }

    try {
      await this.options.onDecryptedMessage?.({
        deviceId: frame.deviceId,
        messageId: frame.messageId,
        counter: frame.counter,
        ts: frame.ts,
        payload,
        raw: {
          type: "web_e2ee_encrypted_msg",
          deviceId: frame.deviceId,
          messageId: frame.messageId,
          counter: frame.counter,
          ts: frame.ts,
          kind: "msg",
          nonceLength: frame.nonce.length,
          ciphertextLength: frame.ciphertext.length,
        },
      });
    } catch {
      this.sendJson(socket, { kind: "error", code: "handler_failed" });
    }
  }

  private bindSocket(deviceId: string, socket: WebSocket): void {
    const current = this.boundSockets.get(deviceId);
    if (current && current !== socket) {
      this.unbindSocket(current);
      try {
        current.close(1008, "replaced by newer session");
      } catch {
        // ignore close failures
      }
    }
    this.boundSockets.set(deviceId, socket);
    this.socketBindings.set(socket, deviceId);
  }

  private unbindSocket(socket: WebSocket): void {
    const deviceId = this.socketBindings.get(socket);
    if (!deviceId) {
      return;
    }
    if (this.boundSockets.get(deviceId) === socket) {
      this.boundSockets.delete(deviceId);
    }
  }

  private sendJson(socket: WebSocket, payload: unknown): void {
    socket.send(JSON.stringify(payload));
  }
}
