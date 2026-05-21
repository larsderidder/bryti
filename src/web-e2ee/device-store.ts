import fs from "node:fs";
import path from "node:path";
import { fingerprintPublicKey, importPublicKeyJwk } from "./crypto.js";
import type { PairedDeviceRecord, PairedDevicesFile } from "./types.js";

function stateDir(dataDir: string): string {
  return path.join(dataDir, "web-e2ee");
}

export function pairedDevicesPath(dataDir: string): string {
  return path.join(stateDir(dataDir), "paired-devices.json");
}

function warnPerm(path_: string, err: unknown): void {
  console.warn(`[web_e2ee] Could not set permissions on ${path_}: ${(err as Error).message}`);
}

function ensureStateDir(dataDir: string): void {
  const dir = stateDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    warnPerm(dir, err);
  }
}

function saveFile(filePath: string, data: PairedDevicesFile): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {
    warnPerm(filePath, err);
  }
}

function loadFile(filePath: string): PairedDevicesFile {
  if (!fs.existsSync(filePath)) {
    return { version: 1, devices: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PairedDevicesFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.devices)) {
    throw new Error("Invalid web_e2ee paired devices file");
  }
  parsed.devices = parsed.devices.map((device) => ({
    ...device,
    lastInboundCounter: typeof device.lastInboundCounter === "number" ? device.lastInboundCounter : 0,
    lastOutboundCounter: typeof device.lastOutboundCounter === "number" ? device.lastOutboundCounter : 0,
  }));
  return parsed;
}

export interface DeviceStore {
  list(): PairedDeviceRecord[];
  get(deviceId: string): PairedDeviceRecord | undefined;
  getActive(deviceId: string): PairedDeviceRecord | undefined;
  add(record: PairedDeviceRecord): Promise<void>;
  markSeen(deviceId: string, at?: string): void;
  updateLastInboundCounter(deviceId: string, counter: number, seenAt?: string): void;
  updateLastOutboundCounter(deviceId: string, counter: number, seenAt?: string): void;
}

export function createDeviceStore(dataDir: string): DeviceStore {
  ensureStateDir(dataDir);
  const filePath = pairedDevicesPath(dataDir);

  return {
    list(): PairedDeviceRecord[] {
      return loadFile(filePath).devices;
    },

    get(deviceId: string): PairedDeviceRecord | undefined {
      return loadFile(filePath).devices.find((d) => d.deviceId === deviceId);
    },

    getActive(deviceId: string): PairedDeviceRecord | undefined {
      return loadFile(filePath).devices.find((d) => d.deviceId === deviceId && d.status === "active");
    },

    async add(record: PairedDeviceRecord): Promise<void> {
      const file = loadFile(filePath);
      if (file.devices.some((d) => d.deviceId === record.deviceId)) {
        throw new Error(`Device already exists: ${record.deviceId}`);
      }
      const publicKey = await importPublicKeyJwk(record.publicKeyJwk);
      const derivedFingerprint = await fingerprintPublicKey(publicKey);
      if (derivedFingerprint !== record.publicKeyFingerprint) {
        throw new Error("Device publicKeyFingerprint does not match publicKeyJwk");
      }
      if (file.devices.some((d) => d.publicKeyFingerprint === record.publicKeyFingerprint)) {
        throw new Error(`Device public key already registered: ${record.publicKeyFingerprint}`);
      }
      file.devices.push(record);
      saveFile(filePath, file);
    },

    markSeen(deviceId: string, at = new Date().toISOString()): void {
      const file = loadFile(filePath);
      const device = file.devices.find((d) => d.deviceId === deviceId);
      if (!device) {
        throw new Error(`Unknown device: ${deviceId}`);
      }
      device.lastSeenAt = at;
      saveFile(filePath, file);
    },

    updateLastInboundCounter(deviceId: string, counter: number, seenAt = new Date().toISOString()): void {
      const file = loadFile(filePath);
      const device = file.devices.find((d) => d.deviceId === deviceId);
      if (!device) {
        throw new Error(`Unknown device: ${deviceId}`);
      }
      device.lastInboundCounter = counter;
      device.lastSeenAt = seenAt;
      saveFile(filePath, file);
    },

    updateLastOutboundCounter(deviceId: string, counter: number, seenAt = new Date().toISOString()): void {
      const file = loadFile(filePath);
      const device = file.devices.find((d) => d.deviceId === deviceId);
      if (!device) {
        throw new Error(`Unknown device: ${deviceId}`);
      }
      device.lastOutboundCounter = counter;
      device.lastSeenAt = seenAt;
      saveFile(filePath, file);
    },
  };
}
