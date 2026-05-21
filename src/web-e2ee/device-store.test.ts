import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { createDeviceStore, pairedDevicesPath } from "./device-store.js";
import { exportPublicKeyJwk, fingerprintPublicKey, generateDeviceId, generateX25519KeyPair } from "./crypto.js";

describe("web-e2ee device store", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/bryti-web-e2ee-devices-");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists paired devices and reloads them", async () => {
    const pair = await generateX25519KeyPair();
    const publicKeyJwk = await exportPublicKeyJwk(pair.publicKey);
    const publicKeyFingerprint = await fingerprintPublicKey(pair.publicKey);
    const store = createDeviceStore(tempDir);

    await store.add({
      deviceId: generateDeviceId(),
      label: "Test device",
      publicKeyJwk,
      publicKeyFingerprint,
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
      status: "active",
      notes: "",
      lastInboundCounter: 0,
      lastOutboundCounter: 0,
    });

    const reloaded = createDeviceStore(tempDir).list();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].publicKeyFingerprint).toBe(publicKeyFingerprint);
    expect(reloaded[0].lastInboundCounter).toBe(0);
    expect(reloaded[0].lastOutboundCounter).toBe(0);
    expect(fs.existsSync(pairedDevicesPath(tempDir))).toBe(true);
  });

  it("rejects duplicate device ids and duplicate fingerprints", async () => {
    const pair = await generateX25519KeyPair();
    const publicKeyJwk = await exportPublicKeyJwk(pair.publicKey);
    const publicKeyFingerprint = await fingerprintPublicKey(pair.publicKey);
    const store = createDeviceStore(tempDir);
    const base = {
      label: "Test device",
      publicKeyJwk,
      publicKeyFingerprint,
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
      status: "active" as const,
      notes: "",
      lastInboundCounter: 0,
      lastOutboundCounter: 0,
    };

    await store.add({ ...base, deviceId: "wed_same" });
    await expect(store.add({ ...base, deviceId: "wed_same" })).rejects.toThrow("Device already exists");
    await expect(store.add({ ...base, deviceId: "wed_other" })).rejects.toThrow("Device public key already registered");
  });

  it("gets active devices and updates lastSeenAt / lastInboundCounter / lastOutboundCounter", async () => {
    const pair = await generateX25519KeyPair();
    const publicKeyJwk = await exportPublicKeyJwk(pair.publicKey);
    const publicKeyFingerprint = await fingerprintPublicKey(pair.publicKey);
    const store = createDeviceStore(tempDir);

    await store.add({
      deviceId: "wed_seen",
      label: "Seen device",
      publicKeyJwk,
      publicKeyFingerprint,
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
      status: "active",
      notes: "",
      lastInboundCounter: 0,
      lastOutboundCounter: 0,
    });

    expect(store.getActive("wed_seen")?.deviceId).toBe("wed_seen");
    store.markSeen("wed_seen", "2026-01-01T00:00:00.000Z");
    store.updateLastInboundCounter("wed_seen", 4, "2026-01-02T00:00:00.000Z");
    store.updateLastOutboundCounter("wed_seen", 6, "2026-01-03T00:00:00.000Z");

    const updated = createDeviceStore(tempDir).get("wed_seen");
    expect(updated?.lastSeenAt).toBe("2026-01-03T00:00:00.000Z");
    expect(updated?.lastInboundCounter).toBe(4);
    expect(updated?.lastOutboundCounter).toBe(6);
  });
});
