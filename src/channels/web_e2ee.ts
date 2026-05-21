// src/channels/web_e2ee.ts   
import { loadOrCreateServerKeyPair } from "../web-e2ee/server-key-store.js";
import { createDeviceStore } from "../web-e2ee/device-store.js";
import { createInviteStore } from "../web-e2ee/invite-store.js";
import { assertValidPublicX25519Jwk, generateDeviceId, importPublicKeyJwk, fingerprintPublicKey } from "../web-e2ee/crypto.js";
import { WebE2EEHttpServer } from "../web-e2ee/http-server.js";
import { WebE2EEWsServer } from "../web-e2ee/ws-server.js";
import type { PairingCompleteRequest } from "../web-e2ee/protocol.js";
import type { ApprovalResult, ChannelBridge, IncomingMessage, SendOpts } from "./types.js";

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * Self-hosted web_e2ee channel bridge.
 *
 * Slice 4c supports encrypted text roundtrips over WebSocket for already paired
 * devices. Richer outbound semantics remain intentionally unimplemented.
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
        designVersion: "slice4c-encrypted-text-roundtrip",
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
          await this.handler({
            channelId: event.deviceId,
            userId: event.deviceId,
            text: event.payload.text,
            platform: "web_e2ee",
            raw: event.raw,
          });
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
    this.assertStarted();
    if (!this.wsServer) {
      throw new Error("web_e2ee websocket server not started");
    }
    return await this.wsServer.sendEncryptedText(channelId, text);
  }

  async editMessage(_channelId: string, _messageId: string, _text: string): Promise<void> {
    this.assertStarted();
    throw new Error("web_e2ee.editMessage is not implemented yet (transport shell only)");
  }

  async sendTyping(_channelId: string): Promise<void> {
    this.assertStarted();
    throw new Error("web_e2ee.sendTyping is not implemented yet (transport shell only)");
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
