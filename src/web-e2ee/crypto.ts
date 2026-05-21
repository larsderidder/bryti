import { base64UrlToBytes, bytesToBase64Url, encodeBase32, normalizeInviteCode, segmentCode, utf8ToBytes } from "./encoding.js";
import {
  canonicalFrameHeaderBytes,
  type CanonicalFrameHeader,
  type EncryptedBindPayload,
  type EncryptedTextPayload,
} from "./protocol.js";

const HKDF_CONTEXT_LABEL = utf8ToBytes("bryti/web_e2ee/v1");
const HKDF_INFO_C2S = utf8ToBytes("bryti/web_e2ee/v1/c2s");
const HKDF_INFO_S2C = utf8ToBytes("bryti/web_e2ee/v1/s2c");

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export async function generateX25519KeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as Promise<CryptoKeyPair>;
}

export async function exportPublicKeyJwk(publicKey: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", publicKey);
}

export async function exportPrivateKeyJwk(privateKey: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", privateKey);
}

export async function importPublicKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "X25519" }, true, []);
}

export async function importPrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "X25519" }, false, ["deriveBits"]);
}

export function assertValidPublicX25519Jwk(jwk: JsonWebKey): void {
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "X25519" ||
    typeof jwk.x !== "string" ||
    !jwk.x ||
    typeof jwk.d === "string"
  ) {
    throw new Error("Invalid X25519 public JWK");
  }
}

export async function exportRawPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  return new Uint8Array(raw);
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const stable = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stable.buffer);
  return new Uint8Array(digest);
}

export async function fingerprintPublicKey(publicKey: CryptoKey): Promise<string> {
  const raw = await exportRawPublicKey(publicKey);
  const digest = await sha256(raw);
  return `sha256:${bytesToBase64Url(digest)}`;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function generateDeviceId(): string {
  return `wed_${bytesToBase64Url(randomBytes(12))}`;
}

export function generateInviteId(): string {
  return `inv_${bytesToBase64Url(randomBytes(12))}`;
}

export function generateMessageId(): string {
  return `msg_${bytesToBase64Url(randomBytes(12))}`;
}

export function generateMessageNonce(): Uint8Array {
  return randomBytes(12);
}

export function generateInviteCode(): string {
  const encoded = encodeBase32(randomBytes(10)).slice(0, 16);
  return segmentCode(encoded, 4);
}

export async function hashInviteCode(code: string): Promise<string> {
  const normalized = normalizeInviteCode(code);
  const digest = await sha256(utf8ToBytes(normalized));
  return `sha256:${bytesToBase64Url(digest)}`;
}

export function publicKeyJwkToRawBytes(jwk: JsonWebKey): Uint8Array {
  if (jwk.kty !== "OKP" || jwk.crv !== "X25519" || typeof jwk.x !== "string") {
    throw new Error("Invalid X25519 public JWK");
  }
  return base64UrlToBytes(jwk.x);
}

export async function deriveSharedSecretBits(privateKey: CryptoKey, publicKey: CryptoKey): Promise<ArrayBuffer> {
  return await crypto.subtle.deriveBits({ name: "X25519", public: publicKey }, privateKey, 256);
}

export async function deriveKeyContextSalt(serverPublicKeyRaw: Uint8Array, devicePublicKeyRaw: Uint8Array): Promise<Uint8Array> {
  return await sha256(concatBytes(HKDF_CONTEXT_LABEL, serverPublicKeyRaw, devicePublicKeyRaw));
}

async function deriveAesGcmKey(secretBits: ArrayBuffer, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  const hkdfBaseKey = await crypto.subtle.importKey("raw", secretBits, "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBufferSource(salt),
      info: toBufferSource(info),
    },
    hkdfBaseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function deriveDirectionalAesKeys(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  serverPublicKeyRaw: Uint8Array,
  devicePublicKeyRaw: Uint8Array,
): Promise<{ c2sKey: CryptoKey; s2cKey: CryptoKey }> {
  const secretBits = await deriveSharedSecretBits(privateKey, publicKey);
  const salt = await deriveKeyContextSalt(serverPublicKeyRaw, devicePublicKeyRaw);
  const [c2sKey, s2cKey] = await Promise.all([
    deriveAesGcmKey(secretBits, salt, HKDF_INFO_C2S),
    deriveAesGcmKey(secretBits, salt, HKDF_INFO_S2C),
  ]);
  return { c2sKey, s2cKey };
}

export async function encryptPayload(
  key: CryptoKey,
  header: CanonicalFrameHeader,
  payload: EncryptedTextPayload | EncryptedBindPayload,
): Promise<string> {
  const plaintextBytes = utf8ToBytes(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toBufferSource(base64UrlToBytes(header.nonce)),
      additionalData: toBufferSource(canonicalFrameHeaderBytes(header)),
    },
    key,
    toBufferSource(plaintextBytes),
  );
  return bytesToBase64Url(new Uint8Array(ciphertext));
}

export async function decryptPayload(
  key: CryptoKey,
  header: CanonicalFrameHeader,
  ciphertextBase64Url: string,
): Promise<unknown> {
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toBufferSource(base64UrlToBytes(header.nonce)),
        additionalData: toBufferSource(canonicalFrameHeaderBytes(header)),
      },
      key,
      toBufferSource(base64UrlToBytes(ciphertextBase64Url)),
    );
  } catch {
    throw new Error("Failed to decrypt encrypted payload");
  }

  try {
    return JSON.parse(Buffer.from(plaintext).toString("utf-8"));
  } catch {
    throw new Error("Failed to parse encrypted payload");
  }
}
