// src/channels/threema.ts
import crypto from "node:crypto";
import fs from "node:fs";
import * as http from "node:http";
import type { IncomingMessage as HttpIncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import nacl from "tweetnacl";
import type { ApprovalResult, AudioAttachment, ChannelBridge, IncomingMessage, SendOpts } from "./types.js";

const TEXT_MESSAGE_TYPE = 0x01;
const FILE_MESSAGE_TYPE = 0x17;
const DELIVERY_RECEIPT_TYPE = 0x80;
const MAX_TEXT_BYTES = 3500;
const MAX_CALLBACK_BODY_BYTES = 64 * 1024;
const MAX_BLOB_BYTES = 20 * 1024 * 1024;
const DEFAULT_VOICE_MESSAGE_TEXT = "The user sent a voice message.";
const THREEMA_FILE_BLOB_NONCE = new Uint8Array(24);
THREEMA_FILE_BLOB_NONCE[23] = 0x01;

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

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

interface ThreemaBlobDownloadResponse {
  data: Uint8Array;
  contentType?: string;
  contentLength?: number;
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
  uploadBlob(params: {
    blob: Uint8Array;
    from: string;
    secret: string;
  }): Promise<string>;
  downloadBlob(params: {
    blobId: string;
    from: string;
    secret: string;
    maxBytes: number;
  }): Promise<ThreemaBlobDownloadResponse>;
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
  encryptFileBlob(params: {
    plaintext: Uint8Array;
    nonce: Uint8Array;
    key: Uint8Array;
  }): Uint8Array;
  decryptFileBlob(params: {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    key: Uint8Array;
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

interface ThreemaFileMessagePayload {
  blobId: string;
  encryptionKey: Uint8Array;
  mimeType: string;
  fileName: string;
  fileSize: number;
  caption?: string;
  thumbnailBlobId?: string;
}

type DecodedMessagePayload =
  | { type: typeof TEXT_MESSAGE_TYPE; text: string }
  | { type: typeof FILE_MESSAGE_TYPE; file: ThreemaFileMessagePayload }
  | { type: number };

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

function createCodedError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
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

function encodeFileMessage(content: Record<string, unknown>, randomBytes: Uint8Array): Uint8Array {
  const inner = new Uint8Array([FILE_MESSAGE_TYPE, ...toUtf8(JSON.stringify(content))]);
  return padMessage(inner, randomBytes);
}

function parseFileMessagePayload(data: Uint8Array): ThreemaFileMessagePayload {
  let content: unknown;
  try {
    content = JSON.parse(fromUtf8(data));
  } catch {
    throw createCodedError("Invalid Threema file payload", "THREEMA_INVALID_FILE_PAYLOAD");
  }

  if (!content || typeof content !== "object") {
    throw createCodedError("Invalid Threema file payload", "THREEMA_INVALID_FILE_PAYLOAD");
  }

  const candidate = content as Record<string, unknown>;
  const blobId = typeof candidate.b === "string" ? candidate.b.trim() : "";
  const encryptionKeyHex = typeof candidate.k === "string" ? candidate.k.trim() : "";
  const mimeType = typeof candidate.m === "string" ? candidate.m.trim() : "";
  const fileName = typeof candidate.n === "string" ? candidate.n.trim() : "";
  const fileSize = typeof candidate.s === "number" ? candidate.s : NaN;
  const caption = typeof candidate.d === "string" && candidate.d.trim() ? candidate.d.trim() : undefined;
  const thumbnailBlobId = typeof candidate.t === "string" && candidate.t.trim() ? candidate.t.trim() : undefined;

  if (
    !hasValidHex(blobId, 32) ||
    !hasValidHex(encryptionKeyHex, 64) ||
    !mimeType ||
    !fileName ||
    !Number.isInteger(fileSize) ||
    fileSize < 0
  ) {
    throw createCodedError("Invalid Threema file payload", "THREEMA_INVALID_FILE_PAYLOAD");
  }

  if (thumbnailBlobId && !hasValidHex(thumbnailBlobId, 32)) {
    throw createCodedError("Invalid Threema thumbnail blob ID", "THREEMA_INVALID_FILE_PAYLOAD");
  }

  return {
    blobId: blobId.toLowerCase(),
    encryptionKey: fromHex(encryptionKeyHex),
    mimeType,
    fileName,
    fileSize,
    caption,
    thumbnailBlobId: thumbnailBlobId?.toLowerCase(),
  };
}

function decodeMessagePayload(payload: Uint8Array): DecodedMessagePayload {
  const unpadded = unpadMessage(payload);
  if (unpadded.length === 0) {
    throw new Error("Invalid Threema payload");
  }
  const type = unpadded[0] ?? 0;
  if (type === TEXT_MESSAGE_TYPE) {
    return { type, text: fromUtf8(unpadded.slice(1)) };
  }
  if (type === FILE_MESSAGE_TYPE) {
    return { type, file: parseFileMessagePayload(unpadded.slice(1)) };
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
  audio?: AudioAttachment[];
  replyMode?: IncomingMessage["replyMode"];
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
    ...(params.audio ? { audio: params.audio } : {}),
    ...(params.replyMode ? { replyMode: params.replyMode } : {}),
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

function sanitizeFileName(fileName: string, fallback = "audio.bin"): string {
  const base = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base || fallback;
}

function inferAudioMimeType(fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase();
  return AUDIO_MIME_BY_EXTENSION[ext];
}

function resolveAudioMimeType(declaredMimeType: string, fileName: string, downloadedMimeType?: string): string {
  const normalizedDeclared = declaredMimeType.trim().toLowerCase();
  if (normalizedDeclared.startsWith("audio/")) return normalizedDeclared;

  const normalizedDownloaded = downloadedMimeType?.split(";", 1)[0].trim().toLowerCase();
  if (normalizedDownloaded?.startsWith("audio/")) return normalizedDownloaded;

  return inferAudioMimeType(fileName) ?? (normalizedDeclared || "application/octet-stream");
}

function isLikelyAudioFileByDeclaredMetadata(declaredMimeType: string, fileName: string): boolean {
  const normalizedDeclared = declaredMimeType.trim().toLowerCase();
  if (normalizedDeclared.startsWith("audio/")) return true;
  return inferAudioMimeType(fileName) != null;
}

function isSupportedAudioFile(declaredMimeType: string, fileName: string, downloadedMimeType?: string): boolean {
  const resolved = resolveAudioMimeType(declaredMimeType, fileName, downloadedMimeType);
  return resolved.startsWith("audio/");
}

function writeTempAudioAttachment(messageId: string, fileName: string, data: Uint8Array, mimeType: string): AudioAttachment {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-threema-audio-"));
  const safeName = sanitizeFileName(fileName);
  const filePath = path.join(dir, `${messageId}-${safeName}`);
  fs.writeFileSync(filePath, Buffer.from(data));

  // TODO: Incoming audio temp files are not cleaned up by the current voice pipeline.
  // Match the existing Telegram voice behavior for now and add explicit cleanup later.
  return {
    path: filePath,
    mimeType,
    fileName: safeName,
  };
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
    async uploadBlob({ blob, from, secret }) {
      const params = new URLSearchParams({ from, secret });
      const form = new FormData();
      form.set("blob", new Blob([Buffer.from(blob)]), "audio.bin");
      const response = await fetch(`${apiBaseUrl}/upload_blob?${params.toString()}`, {
        method: "POST",
        body: form,
      });
      const body = (await response.text()).trim();
      if (!response.ok) {
        throw new Error(`Threema blob upload failed with HTTP ${response.status}`);
      }
      return body;
    },
    async downloadBlob({ blobId, from, secret, maxBytes }) {
      const params = new URLSearchParams({ from, secret });
      const response = await fetch(`${apiBaseUrl}/blobs/${encodeURIComponent(blobId)}?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Threema blob download failed with HTTP ${response.status}`);
      }

      const contentLength = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw createCodedError("Threema blob too large", "THREEMA_BLOB_TOO_LARGE");
      }

      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        throw createCodedError("Threema blob too large", "THREEMA_BLOB_TOO_LARGE");
      }

      return {
        data: buffer,
        contentType: response.headers.get("content-type") ?? undefined,
        contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      };
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
  encryptFileBlob({ plaintext, nonce, key }) {
    return nacl.secretbox(plaintext, nonce, key);
  },
  decryptFileBlob({ ciphertext, nonce, key }) {
    return nacl.secretbox.open(ciphertext, nonce, key);
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
      lastMessageId = await this.sendEncryptedPayload(channelId, publicKey, encodeTextMessage(chunk, this.cryptoOps.randomBytes(1)));
    }

    return lastMessageId;
  }

  async sendVoice(channelId: string, audioPath: string, opts?: { caption?: string }): Promise<string> {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(audioPath);
    } catch (error) {
      throw new Error(`Threema audio file not found: ${(error as Error).message}`);
    }

    if (!stats.isFile()) {
      throw new Error("Threema audio path is not a file");
    }
    if (stats.size > MAX_BLOB_BYTES) {
      throw createCodedError("Threema blob too large", "THREEMA_BLOB_TOO_LARGE");
    }

    const fileContent = new Uint8Array(fs.readFileSync(audioPath));
    const safeFileName = sanitizeFileName(path.basename(audioPath), "voice.ogg");
    const mimeType = inferAudioMimeType(safeFileName) ?? "application/octet-stream";
    const blobKey = this.cryptoOps.randomBytes(32);
    const encryptedBlob = this.cryptoOps.encryptFileBlob({
      plaintext: fileContent,
      nonce: THREEMA_FILE_BLOB_NONCE,
      key: blobKey,
    });
    const blobId = (await this.httpClient.uploadBlob({
      blob: encryptedBlob,
      from: this.config.gatewayId,
      secret: this.config.secret,
    })).trim().toLowerCase();

    if (!hasValidHex(blobId, 32)) {
      throw new Error("Invalid Threema blob ID");
    }

    const payload = encodeFileMessage({
      b: blobId,
      k: toHex(blobKey),
      m: mimeType,
      n: safeFileName,
      s: fileContent.byteLength,
      i: 0,
      ...(opts?.caption ? { d: opts.caption } : {}),
    }, this.cryptoOps.randomBytes(1));

    const publicKey = await this.getPublicKey(channelId);
    return this.sendEncryptedPayload(channelId, publicKey, payload);
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

    let payload: DecodedMessagePayload;
    try {
      payload = decodeMessagePayload(decrypted);
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === "THREEMA_INVALID_FILE_PAYLOAD") {
        return { status: 200, body: "ignored" };
      }
      return { status: 400, body: "invalid payload" };
    }

    if (payload.type === DELIVERY_RECEIPT_TYPE) {
      return { status: 200, body: "ok" };
    }

    if (payload.type === TEXT_MESSAGE_TYPE && "text" in payload) {
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

    if (payload.type === FILE_MESSAGE_TYPE && "file" in payload) {
      const incoming = await this.normalizeIncomingAudioMessage(fields, payload.file).catch((error: Error & { code?: string }) => {
        if (error.code === "THREEMA_BLOB_TOO_LARGE") {
          return null;
        }
        if (error.code === "THREEMA_BLOB_DECRYPT_FAILED") {
          return null;
        }
        throw error;
      });

      if (!incoming) {
        return { status: 200, body: "ignored" };
      }

      if (this.handler) {
        await this.handler(incoming);
      }

      return { status: 200, body: "ok" };
    }

    return { status: 200, body: "ignored" };
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
        throw createCodedError("Callback body too large", "THREEMA_BODY_TOO_LARGE");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async sendEncryptedPayload(channelId: string, publicKey: Uint8Array, plaintext: Uint8Array): Promise<string> {
    const nonce = this.cryptoOps.randomBytes(24);
    const box = this.cryptoOps.encrypt({
      plaintext,
      nonce,
      recipientPublicKey: publicKey,
      privateKey: this.privateKey,
    });

    return this.httpClient.sendE2E({
      from: this.config.gatewayId,
      to: channelId,
      secret: this.config.secret,
      nonceHex: toHex(nonce),
      boxHex: toHex(box),
    });
  }

  private async normalizeIncomingAudioMessage(
    fields: ThreemaCallbackFields,
    payload: ThreemaFileMessagePayload,
  ): Promise<IncomingMessage | null> {
    if (payload.fileSize > MAX_BLOB_BYTES) {
      throw createCodedError("Threema blob too large", "THREEMA_BLOB_TOO_LARGE");
    }

    if (!isLikelyAudioFileByDeclaredMetadata(payload.mimeType, payload.fileName)) {
      return null;
    }

    const blob = await this.httpClient.downloadBlob({
      blobId: payload.blobId,
      from: this.config.gatewayId,
      secret: this.config.secret,
      maxBytes: MAX_BLOB_BYTES,
    });

    if (blob.contentLength != null && blob.contentLength > MAX_BLOB_BYTES) {
      throw createCodedError("Threema blob too large", "THREEMA_BLOB_TOO_LARGE");
    }

    if (!isSupportedAudioFile(payload.mimeType, payload.fileName, blob.contentType)) {
      return null;
    }

    const decrypted = this.cryptoOps.decryptFileBlob({
      ciphertext: blob.data,
      nonce: THREEMA_FILE_BLOB_NONCE,
      key: payload.encryptionKey,
    });
    if (!decrypted) {
      throw createCodedError("Threema blob decryption failed", "THREEMA_BLOB_DECRYPT_FAILED");
    }

    if (decrypted.byteLength !== payload.fileSize) {
      return null;
    }

    const mimeType = resolveAudioMimeType(payload.mimeType, payload.fileName, blob.contentType);
    const audio = [writeTempAudioAttachment(fields.messageId, payload.fileName, decrypted, mimeType)];

    return normalizeThreemaIncomingMessage({
      senderId: fields.from,
      messageId: fields.messageId,
      text: payload.caption || DEFAULT_VOICE_MESSAGE_TEXT,
      date: fields.date,
      to: fields.to,
      nickname: fields.nickname,
      audio,
      replyMode: "voice",
    });
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
  MAX_BLOB_BYTES,
  THREEMA_FILE_BLOB_NONCE,
  chunkTextByUtf8Bytes,
  padMessage,
  encodeTextMessage,
  encodeFileMessage,
  decodeMessagePayload,
  verifyCallbackMac,
  normalizeThreemaIncomingMessage,
};
