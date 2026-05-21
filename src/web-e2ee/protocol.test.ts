import { describe, expect, it } from "vitest";
import {
  assertValidEncryptedBindPayload,
  assertValidEncryptedFrame,
  assertValidEncryptedTextPayload,
  assertValidPairingCompleteRequest,
  canonicalFrameHeaderJson,
  sanitizeDeviceLabel,
} from "./protocol.js";

describe("web-e2ee protocol", () => {
  it("accepts a valid pairing request", () => {
    const request = assertValidPairingCompleteRequest({
      code: "ABCD-EFGH-IJKL-MNOP",
      label: "June Chromium",
      publicKeyJwk: { kty: "OKP", crv: "X25519", x: "abc" },
    });

    expect(request.label).toBe("June Chromium");
    expect(request.publicKeyJwk.crv).toBe("X25519");
  });

  it("rejects malformed pairing requests", () => {
    expect(() => assertValidPairingCompleteRequest(null)).toThrow("Invalid pairing request");
    expect(() => assertValidPairingCompleteRequest({ code: "x", label: "ok" })).toThrow(
      "publicKeyJwk is required",
    );
  });

  it("trims and bounds device labels", () => {
    expect(sanitizeDeviceLabel("  June Chromium  ")).toBe("June Chromium");
    expect(() => sanitizeDeviceLabel("   ")).toThrow("Device label is required");
    expect(() => sanitizeDeviceLabel("x".repeat(121))).toThrow(
      "Device label must be 120 characters or fewer",
    );
  });

  it("canonical aad field order includes nonce and excludes ciphertext", () => {
    const json = canonicalFrameHeaderJson({
      v: 1,
      kind: "msg",
      deviceId: "wed_123",
      messageId: "msg_123",
      counter: 7,
      ts: "2026-01-01T00:00:00.000Z",
      nonce: "nonce123",
      ciphertext: "secret",
    });

    expect(json).toBe(
      JSON.stringify({
        v: 1,
        kind: "msg",
        deviceId: "wed_123",
        messageId: "msg_123",
        counter: 7,
        ts: "2026-01-01T00:00:00.000Z",
        nonce: "nonce123",
      }),
    );
    expect(json).not.toContain("ciphertext");
  });

  it("accepts encrypted msg/bind frames and payloads", () => {
    expect(assertValidEncryptedFrame({
      v: 1,
      kind: "msg",
      deviceId: "wed_123",
      messageId: "msg_123",
      counter: 1,
      ts: "2026-01-01T00:00:00.000Z",
      nonce: "abc",
      ciphertext: "def",
    }).messageId).toBe("msg_123");

    expect(assertValidEncryptedFrame({
      v: 1,
      kind: "bind",
      deviceId: "wed_123",
      messageId: "msg_124",
      counter: 2,
      ts: "2026-01-01T00:00:00.000Z",
      nonce: "ghi",
      ciphertext: "jkl",
    }).kind).toBe("bind");

    expect(assertValidEncryptedTextPayload({ kind: "text", text: "hello" }).text).toBe("hello");
    expect(assertValidEncryptedBindPayload({ kind: "bind" }).kind).toBe("bind");
  });

  it("rejects malformed encrypted frames and invalid payloads", () => {
    expect(() => assertValidEncryptedFrame({ kind: "msg" })).toThrow("Invalid encrypted frame version");
    expect(() => assertValidEncryptedTextPayload({ kind: "text", text: "   " })).toThrow(
      "Encrypted text payload is empty",
    );
    expect(() => assertValidEncryptedBindPayload({ kind: "bind", text: "nope" })).toThrow(
      "Invalid encrypted bind payload",
    );
  });
});
