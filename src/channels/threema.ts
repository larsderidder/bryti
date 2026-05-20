// src/channels/threema.ts
import crypto from "node:crypto";
import fs from "node:fs";
import * as http from "node:http";
import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from "node:http";
import nacl from "tweetnacl";
import type { ApprovalResult, ChannelBridge, IncomingMessage, SendOpts } from "./types.js";

const TEXT_MESSAGE_TYPE = 0x01;
const DELIVERY_RECEIPT_TYPE = 0x80;
const MAX_TEXT_BYTES = 3500;
const MAX_CALLBACK_BODY_BYTES = 64 * 1024;

type MessageHandler = (msg: IncomingMessage) => Promise<void>;

type CallbackResult = { status: number; body: string };

interface ThreemaCallbackFields {
  from: string;
  to: string;
  messageId: string;
  date: string;
  nonce: string;
  box: string;
  mac: string;
  nickname?: string;
}

interface ThreemaSafeRaw {
  from: string;
  to: string;
  messageId: string;
  date: string;
  nickname?: string;
  type: "threema_callback";
}

interface ThreemaHttpClient {
  sendE2E(params: {
    from: string;
    to: string;
    secret: string;
    nonceHex: string;
    boxHex: string;
  }): Promise<string>;
  fetchPublicKey(params: {
    id: string;
    from: string;
    secret: string;
  }): Promise<string>;
}

interface ThreemaCrypto {
  randomBytes(length: number): Uint8Array;
  encrypt(params: {
    plaintext: Uint8Array;
    nonce: Uint8Array;
    recipientPublicKey: Uint8Array;
    privateKey: Uint8Array;
  }): Uint8Array;
  decrypt(params: {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    senderPublicKey: Uint8Array;
    privateKey: Uint8Array;
  }): Uint8Array | null;
}

interface ThreemaBridgeDeps {
  httpClient?: ThreemaHttpClient;
  cryptoOps?: ThreemaCrypto;
  createServer?: typeof http.createServer;
}

interface PendingApproval {
  approvalKey: string;
  resolve: (result: ApprovalResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function toUtf8(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

function fromUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function parseKeyHex(raw: string): string {
  const trimmed = raw.trim();
  const prefixed = trimmed.includes(":") ? trimmed.split(":", 2)[1] : trimmed;
  const normalized = prefixed.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Invalid Threema key format");
  }
  return normalized;
}

function parsePrivateKeyFile(filePath: string): Uint8Array {
  return fromHex(parseKeyHex(fs.readFileSync(filePath, "utf8")));
}

function chunkTextByUtf8Bytes(text: string, maxBytes = MAX_TEXT_BYTES): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const char of text) {
    const next = current + char;
    if (Buffer.byteLength(next, "utf8") > maxBytes) {
      if (current) {
        chunks.push(current);
        current = char;
      } else {
        chunks.push(char);
        current = "";
      }
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function padMessage(inner: Uint8Array, randomBytes: Uint8Array): Uint8Array {
  let padLength = randomBytes[0] ?? 1;
  if (padLength === 0) padLength = 1;
  if (inner.length + padLength < 32) {
    padLength = 32 - inner.length;
  }
  const padding = new Uint8Array(padLength).fill(padLength);
  return new Uint8Array([...inner, ...padding]);
}

function unpadMessage(data: Uint8Array): Uint8Array {
  if (data.length === 0) {
    throw new Error("Invalid Threema payload padding");
  }
  const padLength = data[data.length - 1] ?? 0;
  if (padLength < 1 || padLength > data.length) {
    throw new Error("Invalid Threema payload padding");
  }
  for (let i = data.length - padLength; i < data.length; i++) {
    if (data[i] !== padLength) {
      throw new Error("Invalid Threema payload padding");
    }
  }
  return data.slice(0, data.length - padLength);
}

function encodeTextMessage(text: string, randomBytes: Uint8Array): Uint8Array {
  const inner = new Uint8Array([TEXT_MESSAGE_TYPE, ...toUtf8(text)]);
  return padMessage(inner, randomBytes);
}

function decodeMessagePayload(payload: Uint8Array): { type: number; text?: string } {
  const unpadded = unpadMessage(payload);
  if (unpadded.length === 0) {
    throw new Error("Invalid Threema payload");
  }
  const type = unpadded[0] ?? 0;
  if (type === TEXT_MESSAGE_TYPE) {
    return { type, text: fromUtf8(unpadded.slice(1)) };
  }
  return { type };
}

function normalizeThreemaIncomingMessage(params: {
  senderId: string;
  messageId: string;
  text: string;
  date: string;
  to: string;
  nickname?: string;
}): IncomingMessage {
  return {
    channelId: params.senderId,
    userId: params.senderId,
    messageId: params.messageId,
    text: params.text,
    platform: "threema",
    raw: {
      type: "threema_callback",
      from: params.senderId,
      to: params.to,
      messageId: params.messageId,
      date: params.date,
      ...(params.nickname ? { nickname: params.nickname } : {}),
    } satisfies ThreemaSafeRaw,
  };
}

function parseCallbackFields(form: URLSearchParams): ThreemaCallbackFields | null {
  const from = form.get("from")?.trim();
  const to = form.get("to")?.trim();
  const messageId = form.get("messageId")?.trim();
  const date = form.get("date")?.trim();
  const nonce = form.get("nonce")?.trim();
  const box = form.get("box")?.trim();
  const mac = form.get("mac")?.trim();
  const nickname = form.get("nickname")?.trim() || undefined;

  if (!from || !to || !messageId || !date || !nonce || !box || !mac) {
    return null;
  }

  return { from, to, messageId, date, nonce, box, mac, nickname };
}

function hasValidHex(value: string, expectedLength: number): boolean {
  return value.length === expectedLength && /^[0-9a-f]+$/i.test(value);
}

function verifyCallbackMac(fields: ThreemaCallbackFields, secret: string): boolean {
  const payload = fields.from + fields.to + fields.messageId + fields.date + fields.nonce + fields.box;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(fields.mac, "hex");
  return provided.length === expected.length && crypto.timingSafeEqual(expected, provided);
}

function defaultHttpClient(apiBaseUrl: string): ThreemaHttpClient {
  return {
    async sendE2E({ from, to, secret, nonceHex, boxHex }) {
      const response = await fetch(`${apiBaseUrl}/send_e2e`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: new URLSearchParams({ from, to, secret, nonce: nonceHex, box: boxHex }).toString(),
      });
      const body = (await response.text()).trim();
      if (!response.ok) {
        throw new Error(`Threema send failed with HTTP ${response.status}`);
      }
      return body;
    },
    async fetchPublicKey({ id, from, secret }) {
      const params = new URLSearchParams({ from, secret });
      const response = await fetch(`${apiBaseUrl}/pubkeys/${encodeURIComponent(id)}?${params.toString()}`);
      const body = (await response.text()).trim();
      if (!response.ok) {
        throw new Error(`Threema pubkey lookup failed with HTTP ${response.status}`);
      }
      return body;
    },
  };
}

const defaultCryptoOps: ThreemaCrypto = {
  randomBytes(length) {
    return new Uint8Array(crypto.randomBytes(length));
  },
  encrypt({ plaintext, nonce, recipientPublicKey, privateKey }) {
    return nacl.box(plaintext, nonce, recipientPublicKey, privateKey);
  },
  decrypt({ ciphertext, nonce, senderPublicKey, privateKey }) {
    return nacl.box.open(ciphertext, nonce, senderPublicKey, privateKey);
  },
};

export class ThreemaBridge implements ChannelBridge {
  readonly name = "threema";
  readonly platform = "threema" as const;

  private readonly allowedSenders: Set<string>;
  private readonly privateKey: Uint8Array;
  private readonly httpClient: ThreemaHttpClient;
  private readonly cryptoOps: ThreemaCrypto;
  private readonly createServerImpl: typeof http.createServer;
  private readonly publicKeyCache = new Map<string, Uint8Array>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  private handler: MessageHandler | null = null;
  private server: http.Server | null = null;

  constructor(
    private readonly config: {
      gatewayId: string;
      secret: string;
      privateKeyPath: string;
      allowedSenders: string[];
      apiBaseUrl: string;
      callbackHost: string;
      callbackPort: number;
      callbackPath: string;
    },
    deps: ThreemaBridgeDeps = {},
  ) {
    this.allowedSenders = new Set(config.allowedSenders.map((sender) => sender.trim()).filter(Boolean));
    this.privateKey = parsePrivateKeyFile(config.privateKeyPath);
    this.httpClient = deps.httpClient ?? defaultHttpClient(config.apiBaseUrl);
    this.cryptoOps = deps.cryptoOps ?? defaultCryptoOps;
    this.createServerImpl = deps.createServer ?? http.createServer;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = this.createServerImpl((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.callbackPort, this.config.callbackHost, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    console.log(`[threema] Callback listener started on http://${this.config.callbackHost}:${this.config.callbackPort}${this.config.callbackPath}`);
  }

  async stop(): Promise<void> {
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timeout);
      pending.resolve("deny");
    }
    this.pendingApprovals.clear();

    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    console.log("[threema] Stopped");
  }

  async sendMessage(channelId: string, text: string, _opts?: SendOpts): Promise<string> {
    const publicKey = await this.getPublicKey(channelId);
    const chunks = chunkTextByUtf8Bytes(text);
    let lastMessageId = "";

    for (const chunk of chunks) {
      const nonce = this.cryptoOps.randomBytes(24);
      const padded = encodeTextMessage(chunk, this.cryptoOps.randomBytes(1));
      const box = this.cryptoOps.encrypt({
        plaintext: padded,
        nonce,
        recipientPublicKey: publicKey,
        privateKey: this.privateKey,
      });
      lastMessageId = await this.httpClient.sendE2E({
        from: this.config.gatewayId,
        to: channelId,
        secret: this.config.secret,
        nonceHex: toHex(nonce),
        boxHex: toHex(box),
      });
    }

    return lastMessageId;
  }

  async editMessage(_channelId: string, _messageId: string, _text: string): Promise<void> {
    // Threema Gateway does not support message editing.
  }

  async sendTyping(_channelId: string): Promise<void> {
    // Threema Gateway has no typing indicator API.
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
    await this.sendMessage(
      channelId,
      `${prompt}\n\nReply YES to allow once, ALWAYS to always allow, or NO to deny.`,
    );

    return new Promise<ApprovalResult>((resolve) => {
      const timeout = setTimeout(async () => {
        const pending = this.pendingApprovals.get(channelId);
        if (!pending || pending.approvalKey !== approvalKey) return;
        this.pendingApprovals.delete(channelId);
        resolve("deny");
        try {
          await this.sendMessage(channelId, "Permission request expired (auto-denied).");
        } catch {
          // Best-effort notification.
        }
      }, timeoutMs);

      this.pendingApprovals.set(channelId, { approvalKey, resolve, timeout });
    });
  }

  async receiveCallback(form: URLSearchParams): Promise<CallbackResult> {
    const fields = parseCallbackFields(form);
    if (!fields) {
      return { status: 400, body: "missing required fields" };
    }

    if (
      !hasValidHex(fields.messageId, 16) ||
      !hasValidHex(fields.nonce, 48) ||
      !hasValidHex(fields.mac, 64) ||
      !/^[0-9]+$/.test(fields.date) ||
      !/^[A-Z0-9*]{8}$/.test(fields.from) ||
      !/^[A-Z0-9*]{8}$/.test(fields.to) ||
      !/^[0-9a-f]+$/i.test(fields.box)
    ) {
      return { status: 400, body: "invalid callback fields" };
    }

    if (!verifyCallbackMac(fields, this.config.secret)) {
      return { status: 401, body: "invalid mac" };
    }

    if (fields.to !== this.config.gatewayId) {
      return { status: 400, body: "invalid recipient" };
    }

    if (this.allowedSenders.size > 0 && !this.allowedSenders.has(fields.from)) {
      console.warn(`[threema] Ignoring message from non-allowed sender: ${fields.from}`);
      return { status: 200, body: "ignored" };
    }

    const senderPublicKey = await this.getPublicKey(fields.from);
    const decrypted = this.cryptoOps.decrypt({
      ciphertext: fromHex(fields.box),
      nonce: fromHex(fields.nonce),
      senderPublicKey,
      privateKey: this.privateKey,
    });
    if (!decrypted) {
      return { status: 400, body: "decryption failed" };
    }

    const payload = decodeMessagePayload(decrypted);
    if (payload.type === DELIVERY_RECEIPT_TYPE) {
      return { status: 200, body: "ok" };
    }
    if (payload.type !== TEXT_MESSAGE_TYPE || !payload.text) {
      return { status: 200, body: "ignored" };
    }

    if (this.checkApprovalResponse(fields.from, payload.text)) {
      return { status: 200, body: "ok" };
    }

    if (this.handler) {
      await this.handler(normalizeThreemaIncomingMessage({
        senderId: fields.from,
        messageId: fields.messageId,
        text: payload.text,
        date: fields.date,
        to: fields.to,
        nickname: fields.nickname,
      }));
    }

    return { status: 200, body: "ok" };
  }

  private async handleHttpRequest(req: HttpIncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== this.config.callbackPath) {
      res.writeHead(404).end("not found");
      return;
    }

    try {
      const body = await this.readRequestBody(req);
      const result = await this.receiveCallback(new URLSearchParams(body));
      res.writeHead(result.status, { "content-type": "text/plain; charset=utf-8" }).end(result.body);
    } catch (err) {
      const error = err as Error & { code?: string };
      if (error.code === "THREEMA_BODY_TOO_LARGE") {
        res.writeHead(413).end("request too large");
        return;
      }
      console.error("[threema] Callback handling failed:", error.message);
      res.writeHead(500).end("internal error");
    }
  }

  private async readRequestBody(req: HttpIncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > MAX_CALLBACK_BODY_BYTES) {
        const err = new Error("Callback body too large");
        (err as Error & { code?: string }).code = "THREEMA_BODY_TOO_LARGE";
        throw err;
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async getPublicKey(id: string): Promise<Uint8Array> {
    const cached = this.publicKeyCache.get(id);
    if (cached) return cached;

    const keyHex = parseKeyHex(await this.httpClient.fetchPublicKey({
      id,
      from: this.config.gatewayId,
      secret: this.config.secret,
    }));
    const key = fromHex(keyHex);
    this.publicKeyCache.set(id, key);
    return key;
  }

  private checkApprovalResponse(channelId: string, text: string): boolean {
    const pending = this.pendingApprovals.get(channelId);
    if (!pending) return false;

    const lower = text.trim().toLowerCase();
    let result: ApprovalResult | null = null;
    if (lower === "yes" || lower === "allow") result = "allow";
    else if (lower === "always" || lower === "always allow") result = "allow_always";
    else if (lower === "no" || lower === "deny") result = "deny";
    else return false;

    clearTimeout(pending.timeout);
    this.pendingApprovals.delete(channelId);
    pending.resolve(result);
    return true;
  }
}

export const threemaTestUtils = {
  chunkTextByUtf8Bytes,
  encodeTextMessage,
  decodeMessagePayload,
  verifyCallbackMac,
  normalizeThreemaIncomingMessage,
};
