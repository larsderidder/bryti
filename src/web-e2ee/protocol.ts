import { utf8ToBytes } from "./encoding.js";

export const WEB_E2EE_PROTOCOL_VERSION = 1 as const;
export const WEB_E2EE_MAX_TEXT_LENGTH = 10_000;

export interface PairingCompleteRequest {
  code: string;
  label: string;
  publicKeyJwk: JsonWebKey;
}

export interface PairingCompleteResponse {
  deviceId: string;
  serverPublicKeyJwk: JsonWebKey;
  serverPublicFingerprint: string;
  protocolVersion: 1;
  pathPrefix: string;
}

export interface EncryptedFrame {
  v: 1;
  kind: "msg" | "bind";
  deviceId: string;
  messageId: string;
  counter: number;
  ts: string;
  nonce: string;
  ciphertext: string;
}

export interface CanonicalFrameHeader {
  v: 1;
  kind: "msg" | "bind";
  deviceId: string;
  messageId: string;
  counter: number;
  ts: string;
  nonce: string;
}

export interface EncryptedTextPayload {
  kind: "text";
  text: string;
}

export interface EncryptedBindPayload {
  kind: "bind";
}

export interface DecryptedTextMessageEvent {
  deviceId: string;
  messageId: string;
  counter: number;
  ts: string;
  payload: EncryptedTextPayload;
  raw: {
    type: "web_e2ee_encrypted_msg";
    deviceId: string;
    messageId: string;
    counter: number;
    ts: string;
    kind: "msg";
    nonceLength: number;
    ciphertextLength: number;
  };
}

export function sanitizeDeviceLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    throw new Error("Device label is required");
  }
  if (trimmed.length > 120) {
    throw new Error("Device label must be 120 characters or fewer");
  }
  return trimmed;
}

export function assertValidPairingCompleteRequest(value: unknown): PairingCompleteRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid pairing request");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== "string" || !raw.code.trim()) {
    throw new Error("Pairing code is required");
  }
  if (typeof raw.label !== "string") {
    throw new Error("Device label is required");
  }
  if (!raw.publicKeyJwk || typeof raw.publicKeyJwk !== "object" || Array.isArray(raw.publicKeyJwk)) {
    throw new Error("publicKeyJwk is required");
  }

  return {
    code: raw.code,
    label: sanitizeDeviceLabel(raw.label),
    publicKeyJwk: raw.publicKeyJwk as JsonWebKey,
  };
}

export function assertValidEncryptedFrame(value: unknown): EncryptedFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid encrypted frame");
  }
  const raw = value as Record<string, unknown>;
  if (raw.v !== WEB_E2EE_PROTOCOL_VERSION) {
    throw new Error("Invalid encrypted frame version");
  }
  if (raw.kind !== "msg" && raw.kind !== "bind") {
    throw new Error("Invalid encrypted frame kind");
  }
  if (typeof raw.deviceId !== "string" || !raw.deviceId) {
    throw new Error("Invalid encrypted frame deviceId");
  }
  if (typeof raw.messageId !== "string" || !raw.messageId) {
    throw new Error("Invalid encrypted frame messageId");
  }
  if (typeof raw.counter !== "number" || !Number.isInteger(raw.counter) || raw.counter <= 0) {
    throw new Error("Invalid encrypted frame counter");
  }
  if (typeof raw.ts !== "string" || !raw.ts) {
    throw new Error("Invalid encrypted frame ts");
  }
  if (typeof raw.nonce !== "string" || !raw.nonce) {
    throw new Error("Invalid encrypted frame nonce");
  }
  if (typeof raw.ciphertext !== "string" || !raw.ciphertext) {
    throw new Error("Invalid encrypted frame ciphertext");
  }
  return {
    v: WEB_E2EE_PROTOCOL_VERSION,
    kind: raw.kind,
    deviceId: raw.deviceId,
    messageId: raw.messageId,
    counter: raw.counter,
    ts: raw.ts,
    nonce: raw.nonce,
    ciphertext: raw.ciphertext,
  };
}

export function canonicalFrameHeader(frame: EncryptedFrame | CanonicalFrameHeader): CanonicalFrameHeader {
  return {
    v: WEB_E2EE_PROTOCOL_VERSION,
    kind: frame.kind,
    deviceId: frame.deviceId,
    messageId: frame.messageId,
    counter: frame.counter,
    ts: frame.ts,
    nonce: frame.nonce,
  };
}

export function canonicalFrameHeaderJson(frame: EncryptedFrame | CanonicalFrameHeader): string {
  const header = canonicalFrameHeader(frame);
  return JSON.stringify({
    v: header.v,
    kind: header.kind,
    deviceId: header.deviceId,
    messageId: header.messageId,
    counter: header.counter,
    ts: header.ts,
    nonce: header.nonce,
  });
}

export function canonicalFrameHeaderBytes(frame: EncryptedFrame | CanonicalFrameHeader): Uint8Array {
  return utf8ToBytes(canonicalFrameHeaderJson(frame));
}

export function assertValidEncryptedTextPayload(value: unknown): EncryptedTextPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid encrypted payload");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "text") {
    throw new Error("Invalid encrypted payload kind");
  }
  if (typeof raw.text !== "string") {
    throw new Error("Invalid encrypted payload text");
  }
  const text = raw.text.trim();
  if (!text) {
    throw new Error("Encrypted text payload is empty");
  }
  if (text.length > WEB_E2EE_MAX_TEXT_LENGTH) {
    throw new Error(`Encrypted text payload exceeds ${WEB_E2EE_MAX_TEXT_LENGTH} characters`);
  }
  return { kind: "text", text: raw.text };
}

export function assertValidEncryptedBindPayload(value: unknown): EncryptedBindPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid encrypted payload");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "bind") {
    throw new Error("Invalid encrypted payload kind");
  }
  if (Object.keys(raw).length !== 1) {
    throw new Error("Invalid encrypted bind payload");
  }
  return { kind: "bind" };
}
