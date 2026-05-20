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

describe("ThreemaBridge", () => {
  let tmpDir = "";

  afterEach(() => {
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
    const nonce = crypto.randomBytes(24);
    const payload = threemaTestUtils.encodeTextMessage(text, new Uint8Array([5]));
    const box = nacl.box(payload, nonce, gateway.publicKey, sender.secretKey);
    const fields = {
      from: "ABCDEFGH",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: Buffer.from(nonce).toString("hex"),
      box: Buffer.from(box).toString("hex"),
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

  it("ignores unknown senders", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const fetchPublicKey = vi.fn(async () => Buffer.alloc(32).toString("hex"));
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
      },
    });

    const result = await bridge.receiveCallback(new URLSearchParams({ from: "ABCDEFGH" }));
    expect(result).toEqual({ status: 400, body: "missing required fields" });
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
      .mockImplementationOnce(() => new Uint8Array(24).fill(7))
      .mockImplementationOnce(() => new Uint8Array([9]));

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
      },
      cryptoOps: {
        randomBytes,
        encrypt,
        decrypt: vi.fn(),
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
      },
    });

    const oversized = "x".repeat(64 * 1024 + 1);
    await expect((bridge as any).readRequestBody((async function* () { yield Buffer.from(oversized); })())).rejects.toMatchObject({
      code: "THREEMA_BODY_TOO_LARGE",
    });
  });

  it("does not log plaintext message content while processing callbacks", async () => {
    tmpDir = makeTmpDir();
    const gateway = nacl.box.keyPair();
    const sender = nacl.box.keyPair();
    const privateKeyPath = writePrivateKey(tmpDir, gateway.secretKey);
    const text = "super secret plaintext";
    const nonce = crypto.randomBytes(24);
    const payload = threemaTestUtils.encodeTextMessage(text, new Uint8Array([7]));
    const box = nacl.box(payload, nonce, gateway.publicKey, sender.secretKey);
    const fields = {
      from: "ABCDEFGH",
      to: "*BRYTI01",
      messageId: "0011223344556677",
      date: "1716200000",
      nonce: Buffer.from(nonce).toString("hex"),
      box: Buffer.from(box).toString("hex"),
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
        },
      });
      bridge.onMessage(async () => {});

      await bridge.receiveCallback(new URLSearchParams({
        ...fields,
        mac: macFor(fields, "topsecret"),
      }));

      const combinedLogs = [
        ...logSpy.mock.calls.flat(),
        ...warnSpy.mock.calls.flat(),
        ...errorSpy.mock.calls.flat(),
      ].join(" ");
      expect(combinedLogs).not.toContain(text);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
