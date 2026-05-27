// src/channels/threema.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import nacl from "tweetnacl";
import { ThreemaBridge, threemaTestUtils } from "./threema.js";
import type { IncomingMessage } from "./types.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bryti-threema-test-"));
}

function writePrivateKey(dir: string, key: Uint8Array): string {
  const filePath = path.join(dir, "threema-private.key");
  fs.writeFileSync(filePath, `private:${Buffer.from(key).toString("hex")}\n`, "utf8");
  return filePath;
}

function macFor(fields: {
  from: string;
  to: string;
  messageId: string;
  date: string;
  nonce: string;
  box: string;
}, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(fields.from + fields.to + fields.messageId + fields.date + fields.nonce + fields.box)
    .digest("hex");
}

function encryptCallbackPayload(params: {
  gatewayPublicKey: Uint8Array;
  senderSecretKey: Uint8Array;
  payload: Uint8Array;
}) {
  const nonce = crypto.randomBytes(24);
  const box = nacl.box(params.payload, nonce, params.gatewayPublicKey, params.senderSecretKey);
  return {
    nonceHex: Buffer.from(nonce).toString("hex"),
    boxHex: Buffer.from(box).toString("hex"),
  };
}

describe("ThreemaBridge", () => {
  let tmpDir = "";
  const tempAudioDirs = new Set<string>();

  afterEach(() => {
    for (const dir of tempAudioDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempAudioDirs.clear();

    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("uses PKCS#7-style repeated pad bytes for Threema text payloads", () => {
    const encoded = threemaTestUtils.encodeTextMessage("hi", new Uint8Array([3]));

    expect(encoded[0]).toBe(0x01);
    expect(encoded.length).toBeGreaterThanOrEqual(32);
    expect(Array.from(encoded.slice(-29))).toEqual(new Array(29).fill(29));

    const decoded = threemaTestUtils.decodeMessagePayload(encoded);
    expect(decoded).toEqual({ type: 0x01, text: "hi" });
  });

  it("normalizes a decrypted text callback into IncomingMessage", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const sender = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const text = "hello from threema";
    const payload = threemaTestUtils.encodeTextMessage(text, new Uint8Array([5]));
    const encrypted = encryptCallbackPayload({
      gatewayPublicKey: gateway.publicKey,
      senderSecretKey: sender.secretKey,
      payload,
    });
    const fields = {
      from: "ABCDEFGH",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: encrypted.nonceHex,
      box: encrypted.boxHex,
    };

    const fetchPublicKey = vi.fn(async ({ id }: { id: string }) => {
      if (id === "ABCDEFGH") return Buffer.from(sender.publicKey).toString("hex");
      throw new Error("unexpected pubkey lookup");
    });

    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey,
        downloadBlob: vi.fn(),
      },
    });

    const received: IncomingMessage[] = [];
    bridge.onMessage(async (msg) => {
      received.push(msg);
    });

    const result = await bridge.receiveCallback(new URLSearchParams({
      ...fields,
      mac: macFor(fields, "topsecret"),
      nickname: "Alice",
    }));

    expect(result).toEqual({ status: 200, body: "ok" });
    expect(received).toEqual([{
      channelId: "ABCDEFGH",
      userId: "ABCDEFGH",
      messageId: "0011223344556677",
      text,
      platform: "threema",
      raw: {
        type: "threema_callback",
        from: "ABCDEFGH",
        to: "*BRYTI01",
        messageId: "0011223344556677",
        date: "1716200000",
        nickname: "Alice",
      },
    }]);
    expect(fetchPublicKey).toHaveBeenCalledWith({
      id: "ABCDEFGH",
      from: "*BRYTI01",
      secret: "topsecret",
    });
  });

  it("normalizes an incoming Threema audio file into IncomingMessage.audio", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const sender = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const fileKey = crypto.randomBytes(32);
    const decryptedAudio = Buffer.from("OggS fake audio payload", "utf8");
    const encryptedAudio = nacl.secretbox(
      decryptedAudio,
      threemaTestUtils.THREEMA_FILE_BLOB_NONCE,
      fileKey,
    );
    const blobId = "aa".repeat(16);
    const payload = threemaTestUtils.encodeFileMessage({
      b: blobId,
      k: Buffer.from(fileKey).toString("hex"),
      m: "audio/ogg",
      n: "voice-note.ogg",
      s: decryptedAudio.length,
    }, new Uint8Array([9]));
    const encrypted = encryptCallbackPayload({
      gatewayPublicKey: gateway.publicKey,
      senderSecretKey: sender.secretKey,
      payload,
    });
    const fields = {
      from: "ABCDEFGH",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: encrypted.nonceHex,
      box: encrypted.boxHex,
    };

    const downloadBlob = vi.fn(async () => ({
      data: new Uint8Array(encryptedAudio),
      contentType: "audio/ogg",
      contentLength: encryptedAudio.length,
    }));
    const decryptFileBlob = vi.fn(({ ciphertext, nonce, key }: { ciphertext: Uint8Array; nonce: Uint8Array; key: Uint8Array }) => (
      nacl.secretbox.open(ciphertext, nonce, key)
    ));

    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey: vi.fn(async () => Buffer.from(sender.publicKey).toString("hex")),
        downloadBlob,
      },
      cryptoOps: {
        randomBytes: (length) => new Uint8Array(crypto.randomBytes(length)),
        encrypt: ({ plaintext, nonce, recipientPublicKey, privateKey }) => nacl.box(plaintext, nonce, recipientPublicKey, privateKey),
        decrypt: ({ ciphertext, nonce, senderPublicKey, privateKey }) => nacl.box.open(ciphertext, nonce, senderPublicKey, privateKey),
        decryptFileBlob,
      },
    });

    const received: IncomingMessage[] = [];
    bridge.onMessage(async (msg) => {
      received.push(msg);
    });

    const result = await bridge.receiveCallback(new URLSearchParams({
      ...fields,
      mac: macFor(fields, "topsecret"),
    }));

    expect(result).toEqual({ status: 200, body: "ok" });
    expect(downloadBlob).toHaveBeenCalledWith({
      blobId,
      from: "*BRYTI01",
      secret: "topsecret",
      maxBytes: threemaTestUtils.MAX_BLOB_BYTES,
    });
    expect(decryptFileBlob).toHaveBeenCalledWith({
      ciphertext: new Uint8Array(encryptedAudio),
      nonce: threemaTestUtils.THREEMA_FILE_BLOB_NONCE,
      key: new Uint8Array(fileKey),
    });

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg.channelId).toBe("ABCDEFGH");
    expect(msg.userId).toBe("ABCDEFGH");
    expect(msg.messageId).toBe("0011223344556677");
    expect(msg.text).toBe("The user sent a voice message.");
    expect(msg.platform).toBe("threema");
    expect(msg.replyMode).toBe("voice");
    expect(msg.raw).toEqual({
      type: "threema_callback",
      from: "ABCDEFGH",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
    });
    expect(msg.audio).toHaveLength(1);
    expect(msg.audio?.[0]?.mimeType).toBe("audio/ogg");
    expect(msg.audio?.[0]?.fileName).toBe("voice-note.ogg");
    expect(fs.existsSync(msg.audio?.[0]?.path ?? "")).toBe(true);
    expect(fs.readFileSync(msg.audio?.[0]?.path ?? "")).toEqual(decryptedAudio);
    tempAudioDirs.add(path.dirname(msg.audio?.[0]?.path ?? ""));
  });

  it("ignores unknown senders without fetching keys or blobs", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const fetchPublicKey = vi.fn(async () => Buffer.alloc(32).toString("hex"));
    const downloadBlob = vi.fn();
    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey,
        downloadBlob,
      },
    });

    const fields = {
      from: "ZZZZZZZZ",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: "00".repeat(24),
      box: "00",
    };

    const result = await bridge.receiveCallback(new URLSearchParams({
      ...fields,
      mac: macFor(fields, "topsecret"),
    }));

    expect(result).toEqual({ status: 200, body: "ignored" });
    expect(fetchPublicKey).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("rejects callbacks for a different gateway recipient", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey: vi.fn(),
        downloadBlob: vi.fn(),
      },
    });

    const fields = {
      from: "ABCDEFGH",
      to: "*OTHER01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: "00".repeat(24),
      box: "00",
    };

    const result = await bridge.receiveCallback(new URLSearchParams({
      ...fields,
      mac: macFor(fields, "topsecret"),
    }));

    expect(result).toEqual({ status: 400, body: "invalid recipient" });
  });

  it("rejects callbacks with missing required fields", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey: vi.fn(),
        downloadBlob: vi.fn(),
      },
    });

    const result = await bridge.receiveCallback(new URLSearchParams({ from: "ABCDEFGH" }));
    expect(result).toEqual({ status: 400, body: "missing required fields" });
  });

  it("ignores unsupported decrypted message types", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const sender = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const payload = threemaTestUtils.padMessage(new Uint8Array([0x02]), new Uint8Array([3]));
    const encrypted = encryptCallbackPayload({
      gatewayPublicKey: gateway.publicKey,
      senderSecretKey: sender.secretKey,
      payload,
    });
    const fields = {
      from: "ABCDEFGH",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: encrypted.nonceHex,
      box: encrypted.boxHex,
    };

    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey: vi.fn(async () => Buffer.from(sender.publicKey).toString("hex")),
        downloadBlob: vi.fn(),
      },
    });

    const handler = vi.fn();
    bridge.onMessage(handler);

    const result = await bridge.receiveCallback(new URLSearchParams({
      ...fields,
      mac: macFor(fields, "topsecret"),
    }));

    expect(result).toEqual({ status: 200, body: "ignored" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores malformed file payloads safely", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const sender = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const payload = threemaTestUtils.padMessage(
      new Uint8Array([0x17, ...Buffer.from("not-json", "utf8")]),
      new Uint8Array([5]),
    );
    const encrypted = encryptCallbackPayload({
      gatewayPublicKey: gateway.publicKey,
      senderSecretKey: sender.secretKey,
      payload,
    });
    const fields = {
      from: "ABCDEFGH",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: encrypted.nonceHex,
      box: encrypted.boxHex,
    };

    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey: vi.fn(async () => Buffer.from(sender.publicKey).toString("hex")),
        downloadBlob: vi.fn(),
      },
    });

    const handler = vi.fn();
    bridge.onMessage(handler);

    const result = await bridge.receiveCallback(new URLSearchParams({
      ...fields,
      mac: macFor(fields, "topsecret"),
    }));

    expect(result).toEqual({ status: 200, body: "ignored" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores declared oversized files without downloading blobs", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const sender = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const downloadBlob = vi.fn();
    const payload = threemaTestUtils.encodeFileMessage({
      b: "aa".repeat(16),
      k: "11".repeat(32),
      m: "audio/ogg",
      n: "voice.ogg",
      s: threemaTestUtils.MAX_BLOB_BYTES + 1,
    }, new Uint8Array([7]));
    const encrypted = encryptCallbackPayload({
      gatewayPublicKey: gateway.publicKey,
      senderSecretKey: sender.secretKey,
      payload,
    });
    const fields = {
      from: "ABCDEFGH",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: encrypted.nonceHex,
      box: encrypted.boxHex,
    };

    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey: vi.fn(async () => Buffer.from(sender.publicKey).toString("hex")),
        downloadBlob,
      },
    });

    const handler = vi.fn();
    bridge.onMessage(handler);

    const result = await bridge.receiveCallback(new URLSearchParams({
      ...fields,
      mac: macFor(fields, "topsecret"),
    }));

    expect(result).toEqual({ status: 200, body: "ignored" });
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores declared non-audio files without downloading blobs", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const sender = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const downloadBlob = vi.fn();
    const payload = threemaTestUtils.encodeFileMessage({
      b: "aa".repeat(16),
      k: "11".repeat(32),
      m: "application/pdf",
      n: "document.pdf",
      s: 123,
    }, new Uint8Array([7]));
    const encrypted = encryptCallbackPayload({
      gatewayPublicKey: gateway.publicKey,
      senderSecretKey: sender.secretKey,
      payload,
    });
    const fields = {
      from: "ABCDEFGH",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: encrypted.nonceHex,
      box: encrypted.boxHex,
    };

    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey: vi.fn(async () => Buffer.from(sender.publicKey).toString("hex")),
        downloadBlob,
      },
    });

    const handler = vi.fn();
    bridge.onMessage(handler);

    const result = await bridge.receiveCallback(new URLSearchParams({
      ...fields,
      mac: macFor(fields, "topsecret"),
    }));

    expect(result).toEqual({ status: 200, body: "ignored" });
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores oversized blobs safely after download starts", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const sender = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const payload = threemaTestUtils.encodeFileMessage({
      b: "aa".repeat(16),
      k: "11".repeat(32),
      m: "audio/ogg",
      n: "voice.ogg",
      s: 123,
    }, new Uint8Array([7]));
    const encrypted = encryptCallbackPayload({
      gatewayPublicKey: gateway.publicKey,
      senderSecretKey: sender.secretKey,
      payload,
    });
    const fields = {
      from: "ABCDEFGH",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: encrypted.nonceHex,
      box: encrypted.boxHex,
    };

    const downloadBlob = vi.fn(async () => {
      throw Object.assign(new Error("too large"), { code: "THREEMA_BLOB_TOO_LARGE" });
    });

    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey: vi.fn(async () => Buffer.from(sender.publicKey).toString("hex")),
        downloadBlob,
      },
    });

    const handler = vi.fn();
    bridge.onMessage(handler);

    const result = await bridge.receiveCallback(new URLSearchParams({
      ...fields,
      mac: macFor(fields, "topsecret"),
    }));

    expect(result).toEqual({ status: 200, body: "ignored" });
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("sendVoice reads audio, encrypts blob, uploads it, and sends an E2E file message", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const audioPath = path.join(tmpDir, "reply.ogg");
    fs.writeFileSync(audioPath, Buffer.from("fake tts audio", "utf8"));

    const sendE2E = vi.fn(async () => "voice-msg-123");
    const uploadBlob = vi.fn(async () => "aa".repeat(16));
    const fetchPublicKey = vi.fn(async () => "11".repeat(32));
    const encrypt = vi.fn(({ plaintext }: { plaintext: Uint8Array }) => plaintext);
    const encryptFileBlob = vi.fn(() => new Uint8Array([9, 8, 7]));
    const randomBytes = vi
      .fn<(...args: [number]) => Uint8Array>()
      .mockImplementationOnce(() => new Uint8Array(32).fill(5))
      .mockImplementationOnce(() => new Uint8Array([9]))
      .mockImplementationOnce(() => new Uint8Array(24).fill(7));

    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E,
        fetchPublicKey,
        uploadBlob,
        downloadBlob: vi.fn(),
      },
      cryptoOps: {
        randomBytes,
        encrypt,
        decrypt: vi.fn(),
        encryptFileBlob,
        decryptFileBlob: vi.fn(),
      },
    });

    const messageId = await bridge.sendVoice!("ABCDEFGH", audioPath, { caption: "Audio reply" });

    expect(messageId).toBe("voice-msg-123");
    expect(encryptFileBlob).toHaveBeenCalledWith({
      plaintext: new Uint8Array(fs.readFileSync(audioPath)),
      nonce: threemaTestUtils.THREEMA_FILE_BLOB_NONCE,
      key: new Uint8Array(32).fill(5),
    });
    expect(uploadBlob).toHaveBeenCalledWith({
      blob: new Uint8Array([9, 8, 7]),
      from: "*BRYTI01",
      secret: "topsecret",
    });
    expect(fetchPublicKey).toHaveBeenCalledWith({
      id: "ABCDEFGH",
      from: "*BRYTI01",
      secret: "topsecret",
    });
    expect(sendE2E).toHaveBeenCalledWith({
      from: "*BRYTI01",
      to: "ABCDEFGH",
      secret: "topsecret",
      nonceHex: "07".repeat(24),
      boxHex: expect.any(String),
    });

    const outbound = threemaTestUtils.decodeMessagePayload(Buffer.from(sendE2E.mock.calls[0][0].boxHex, "hex"));
    expect(outbound.type).toBe(0x17);
    if (outbound.type === 0x17 && "file" in outbound) {
      expect(outbound.file.blobId).toBe("aa".repeat(16));
      expect(outbound.file.mimeType).toBe("audio/ogg");
      expect(outbound.file.fileName).toBe("reply.ogg");
      expect(outbound.file.fileSize).toBe(fs.statSync(audioPath).size);
      expect(outbound.file.caption).toBe("Audio reply");
      expect(Buffer.from(outbound.file.encryptionKey)).toEqual(Buffer.from(new Uint8Array(32).fill(5)));
    }
  });

  it("sendVoice rejects oversized local files before upload", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const audioPath = path.join(tmpDir, "reply.ogg");
    fs.writeFileSync(audioPath, Buffer.from("x"));
    const statSpy = vi.spyOn(fs, "statSync").mockReturnValue({
      isFile: () => true,
      size: threemaTestUtils.MAX_BLOB_BYTES + 1,
    } as fs.Stats);

    try {
      const uploadBlob = vi.fn();
      const bridge = new ThreemaBridge({
        gatewayId: "*BRYTI01",
        secret: "topsecret",
        privateKeyPath,
        allowedSenders: ["ABCDEFGH"],
        apiBaseUrl: "https://msgapi.threema.ch",
        callbackHost: "127.0.0.1",
        callbackPort: 8787,
        callbackPath: "/threema/callback",
      }, {
        httpClient: {
          sendE2E: vi.fn(),
          fetchPublicKey: vi.fn(),
          uploadBlob,
          downloadBlob: vi.fn(),
        },
      });

      await expect(bridge.sendVoice!("ABCDEFGH", audioPath)).rejects.toMatchObject({ code: "THREEMA_BLOB_TOO_LARGE" });
      expect(uploadBlob).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
    }
  });

  it("sendVoice handles missing local files safely", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const uploadBlob = vi.fn();
    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey: vi.fn(),
        uploadBlob,
        downloadBlob: vi.fn(),
      },
    });

    await expect(bridge.sendVoice!("ABCDEFGH", path.join(tmpDir, "missing.ogg"))).rejects.toThrow("Threema audio file not found");
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it("sendVoice infers mime types for common TTS output extensions", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const audioPath = path.join(tmpDir, "reply.mp3");
    fs.writeFileSync(audioPath, Buffer.from("fake tts audio", "utf8"));

    const sendE2E = vi.fn(async () => "voice-msg-123");
    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E,
        fetchPublicKey: vi.fn(async () => "11".repeat(32)),
        uploadBlob: vi.fn(async () => "aa".repeat(16)),
        downloadBlob: vi.fn(),
      },
      cryptoOps: {
        randomBytes: vi
          .fn<(...args: [number]) => Uint8Array>()
          .mockImplementationOnce(() => new Uint8Array(32).fill(1))
          .mockImplementationOnce(() => new Uint8Array([9]))
          .mockImplementationOnce(() => new Uint8Array(24).fill(2)),
        encrypt: ({ plaintext }) => plaintext,
        decrypt: vi.fn(),
        encryptFileBlob: ({ plaintext }) => plaintext,
        decryptFileBlob: vi.fn(),
      },
    });

    await bridge.sendVoice!("ABCDEFGH", audioPath);

    const outbound = threemaTestUtils.decodeMessagePayload(Buffer.from(sendE2E.mock.calls[0][0].boxHex, "hex"));
    expect(outbound.type).toBe(0x17);
    if (outbound.type === 0x17 && "file" in outbound) {
      expect(outbound.file.mimeType).toBe("audio/mpeg");
      expect(outbound.file.fileName).toBe("reply.mp3");
    }
  });

  it("sendMessage delegates to the E2E API client with encrypted payload", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const sendE2E = vi.fn(async () => "msg-123");
    const fetchPublicKey = vi.fn(async () => "11".repeat(32));
    const encrypt = vi.fn(() => new Uint8Array([1, 2, 3]));
    const randomBytes = vi
      .fn<(...args: [number]) => Uint8Array>()
      .mockImplementationOnce(() => new Uint8Array([9]))
      .mockImplementationOnce(() => new Uint8Array(24).fill(7));

    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E,
        fetchPublicKey,
        downloadBlob: vi.fn(),
      },
      cryptoOps: {
        randomBytes,
        encrypt,
        decrypt: vi.fn(),
        decryptFileBlob: vi.fn(),
      },
    });

    const messageId = await bridge.sendMessage("ABCDEFGH", "hello");

    expect(messageId).toBe("msg-123");
    expect(fetchPublicKey).toHaveBeenCalledWith({
      id: "ABCDEFGH",
      from: "*BRYTI01",
      secret: "topsecret",
    });
    expect(encrypt).toHaveBeenCalled();
    expect(sendE2E).toHaveBeenCalledWith({
      from: "*BRYTI01",
      to: "ABCDEFGH",
      secret: "topsecret",
      nonceHex: "07".repeat(24),
      boxHex: "010203",
    });
  });

  it("rejects oversized callback bodies safely", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const bridge = new ThreemaBridge({
      gatewayId: "*BRYTI01",
      secret: "topsecret",
      privateKeyPath,
      allowedSenders: ["ABCDEFGH"],
      apiBaseUrl: "https://msgapi.threema.ch",
      callbackHost: "127.0.0.1",
      callbackPort: 8787,
      callbackPath: "/threema/callback",
    }, {
      httpClient: {
        sendE2E: vi.fn(),
        fetchPublicKey: vi.fn(),
        downloadBlob: vi.fn(),
      },
    });

    const oversized = "x".repeat(64 * 1024 + 1);
    await expect((bridge as any).readRequestBody((async function* () { yield Buffer.from(oversized); })())).rejects.toMatchObject({
      code: "THREEMA_BODY_TOO_LARGE",
    });
  });

  it("does not log plaintext text or decrypted audio content while processing callbacks", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const sender = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const fileKey = crypto.randomBytes(32);
    const secretText = "super secret audio payload";
    const decryptedAudio = Buffer.from(secretText, "utf8");
    const encryptedAudio = nacl.secretbox(
      decryptedAudio,
      threemaTestUtils.THREEMA_FILE_BLOB_NONCE,
      fileKey,
    );
    const payload = threemaTestUtils.encodeFileMessage({
      b: "aa".repeat(16),
      k: Buffer.from(fileKey).toString("hex"),
      m: "audio/ogg",
      n: "secret.ogg",
      s: decryptedAudio.length,
    }, new Uint8Array([11]));
    const encrypted = encryptCallbackPayload({
      gatewayPublicKey: gateway.publicKey,
      senderSecretKey: sender.secretKey,
      payload,
    });
    const fields = {
      from: "ABCDEFGH",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: encrypted.nonceHex,
      box: encrypted.boxHex,
    };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const bridge = new ThreemaBridge({
        gatewayId: "*BRYTI01",
        secret: "topsecret",
        privateKeyPath,
        allowedSenders: ["ABCDEFGH"],
        apiBaseUrl: "https://msgapi.threema.ch",
        callbackHost: "127.0.0.1",
        callbackPort: 8787,
        callbackPath: "/threema/callback",
      }, {
        httpClient: {
          sendE2E: vi.fn(),
          fetchPublicKey: vi.fn(async () => Buffer.from(sender.publicKey).toString("hex")),
          downloadBlob: vi.fn(async () => ({
            data: new Uint8Array(encryptedAudio),
            contentType: "audio/ogg",
            contentLength: encryptedAudio.length,
          })),
        },
      });
      bridge.onMessage(async (msg) => {
        const audioPath = msg.audio?.[0]?.path;
        if (audioPath) tempAudioDirs.add(path.dirname(audioPath));
      });

      await bridge.receiveCallback(new URLSearchParams({
        ...fields,
        mac: macFor(fields, "topsecret"),
      }));

      const combinedLogs = [
        ...logSpy.mock.calls.flat(),
        ...warnSpy.mock.calls.flat(),
        ...errorSpy.mock.calls.flat(),
      ].join(" ");
      expect(combinedLogs).not.toContain(secretText);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
