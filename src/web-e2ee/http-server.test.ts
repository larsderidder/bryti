// src/web-e2ee/http-server.test.ts         
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertValidPublicX25519Jwk,
  exportPublicKeyJwk,
  fingerprintPublicKey,
  generateDeviceId,
  generateX25519KeyPair,
  importPublicKeyJwk,
} from "./crypto.js";
import { createDeviceStore } from "./device-store.js";
import { WebE2EEHttpServer } from "./http-server.js";
import { createInviteStore } from "./invite-store.js";
import type { PairingCompleteRequest } from "./protocol.js";
import { loadOrCreateServerKeyPair } from "./server-key-store.js";

async function createServer(pathPrefix = "/") {
  const tempDir = fs.mkdtempSync("/tmp/bryti-web-e2ee-http-");
  const serverKeys = await loadOrCreateServerKeyPair(tempDir);
  const deviceStore = createDeviceStore(tempDir);
  const inviteStore = createInviteStore(tempDir);
  const server = new WebE2EEHttpServer({
    listenHost: "127.0.0.1",
    listenPort: 0,
    publicOrigin: "https://chat.example.test",
    pathPrefix,
    serverInfo: {
      channel: "web_e2ee",
      protocolVersion: 1,
      designVersion: "slice4c-encrypted-text-roundtrip",
      serverPublicFingerprint: serverKeys.fingerprint,
      pathPrefix,
      pairingEnabled: true,
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
        protocolVersion: 1 as const,
        pathPrefix,
      };
    },
  });
  await server.start();
  return { tempDir, server, fingerprint: serverKeys.fingerprint, serverKeys, deviceStore, inviteStore };
}

describe("WebE2EEHttpServer", () => {
  const tempDirs: string[] = [];
  const servers: WebE2EEHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves index.html", async () => {
    const created = await createServer("/");
    tempDirs.push(created.tempDir);
    servers.push(created.server);

    const response = await fetch(`${created.server.getBaseUrl()}/`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body).toContain("Bryti web_e2ee");
  });

  it("serves /api/server-info without private data", async () => {
    const created = await createServer("/");
    tempDirs.push(created.tempDir);
    servers.push(created.server);

    const response = await fetch(`${created.server.getBaseUrl()}/api/server-info`);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.channel).toBe("web_e2ee");
    expect(body.serverPublicFingerprint).toBe(created.fingerprint);
    expect(body.chatEnabled).toBe(true);
    expect(body.encryptedTransport).toBe(true);
    expect(body.privateKeyJwk).toBeUndefined();
    expect(body.inviteCodes).toBeUndefined();
  });

  it("respects path_prefix", async () => {
    const created = await createServer("/chat");
    tempDirs.push(created.tempDir);
    servers.push(created.server);

    const indexResponse = await fetch(`${created.server.getBaseUrl()}/chat`);
    const apiResponse = await fetch(`${created.server.getBaseUrl()}/chat/api/server-info`);

    expect(indexResponse.status).toBe(200);
    expect(apiResponse.status).toBe(200);
  });

  it("returns 404 for unknown static paths", async () => {
    const created = await createServer("/");
    tempDirs.push(created.tempDir);
    servers.push(created.server);

    const response = await fetch(`${created.server.getBaseUrl()}/missing.js`);
    expect(response.status).toBe(404);
  });

  it("rejects obvious path traversal", async () => {
    const created = await createServer("/");
    tempDirs.push(created.tempDir);
    servers.push(created.server);

    const response = await fetch(`${created.server.getBaseUrl()}/..%2Fpackage.json`);
    expect([400, 404]).toContain(response.status);
  });

  it("POST pairing complete consumes valid invite and returns registration response", async () => {
    const created = await createServer("/");
    tempDirs.push(created.tempDir);
    servers.push(created.server);
    const invite = await created.inviteStore.create(10);
    const pair = await generateX25519KeyPair();
    const publicKeyJwk = await exportPublicKeyJwk(pair.publicKey);

    const response = await fetch(`${created.server.getBaseUrl()}/api/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: invite.code,
        label: "June Chromium",
        publicKeyJwk,
      }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.deviceId).toMatch(/^wed_/);
    expect(body.serverPublicFingerprint).toBe(created.fingerprint);
    expect(body.protocolVersion).toBe(1);
    expect(body.pathPrefix).toBe("/");
    expect(body.serverPublicKeyJwk).toEqual(created.serverKeys.publicKeyJwk);

    const stored = created.deviceStore.get(String(body.deviceId));
    expect(stored?.label).toBe("June Chromium");
    expect(stored?.lastInboundCounter).toBe(0);
    expect(stored?.lastOutboundCounter).toBe(0);

    expect(body.privateKeyJwk).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(invite.code);
  });

  it("POST pairing complete rejects invalid invite code", async () => {
    const created = await createServer("/");
    tempDirs.push(created.tempDir);
    servers.push(created.server);
    const pair = await generateX25519KeyPair();
    const publicKeyJwk = await exportPublicKeyJwk(pair.publicKey);

    const response = await fetch(`${created.server.getBaseUrl()}/api/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ABCD-EFGH-IJKL-MNOP", label: "June", publicKeyJwk }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid pairing invite code");
  });

  it("POST pairing complete rejects expired or reused invite codes", async () => {
    const created = await createServer("/");
    tempDirs.push(created.tempDir);
    servers.push(created.server);
    const pair = await generateX25519KeyPair();
    const publicKeyJwk = await exportPublicKeyJwk(pair.publicKey);
    const invite = await created.inviteStore.create(10);
    await created.inviteStore.consume(invite.code, "wed_existing");

    const reused = await fetch(`${created.server.getBaseUrl()}/api/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: invite.code, label: "June", publicKeyJwk }),
    });

    expect(reused.status).toBe(400);
    expect(await reused.text()).toContain("already been used");
  });

  it("POST pairing complete rejects malformed public key jwk", async () => {
    const created = await createServer("/");
    tempDirs.push(created.tempDir);
    servers.push(created.server);
    const invite = await created.inviteStore.create(10);

    const response = await fetch(`${created.server.getBaseUrl()}/api/pairing/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: invite.code,
        label: "June Chromium",
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "abc" },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid X25519 public JWK");
  });

  it("server-info reports encrypted text roundtrip availability", async () => {
    const created = await createServer("/");
    tempDirs.push(created.tempDir);
    servers.push(created.server);

    const response = await fetch(`${created.server.getBaseUrl()}/api/server-info`);
    const body = await response.json() as Record<string, unknown>;

    expect(body.chatEnabled).toBe(true);
    expect(body.encryptedTransport).toBe(true);
  });
});
