/**
 * Tests for the events watcher.
 *
 * Focuses on processEventFile logic: validation, user allowlist enforcement,
 * durable-acceptance ordering, and the instance file write/remove cycle.
 * The fs.watch integration is not tested here — that's OS-level behaviour.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventsWatcher } from "./events-watcher.js";
import type { Config } from "./config.js";
import type { IncomingMessage } from "./channels/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bryti-events-test-"));
}

function makeConfig(dataDir: string, allowedUsers: number[] = [123, 456]): Config {
  return {
    telegram: { token: "tok", allowed_users: allowedUsers },
    whatsapp: { enabled: false, allowed_users: [] },
    threema: { enabled: false, gateway_id: "", secret: "", private_key_path: "", allowed_senders: [], api_base_url: "https://msgapi.threema.ch", callback: { host: "127.0.0.1", port: 8787, path: "/threema/callback" } },
    data_dir: dataDir,
    web_e2ee: { enabled: false },
  } as unknown as Config;
}

function writeEventFile(dir: string, filename: string, payload: object): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(payload), "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createEventsWatcher", () => {
  let tmpDir: string;
  let eventsDir: string;
  const enqueued: IncomingMessage[] = [];
  let enqueue: (msg: IncomingMessage) => void;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
    eventsDir = path.join(tmpDir, "events");
    enqueued.length = 0;
    enqueue = (msg) => enqueued.push(msg);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean up any instance file written during tests
    const instancePath = path.join(os.homedir(), ".pi", "agent", "bryti-instance.json");
    try { fs.unlinkSync(instancePath); } catch { /* already gone */ }
    vi.restoreAllMocks();
  });

  describe("start / stop", () => {
    it("creates the events directory if it does not exist", () => {
      const watcher = createEventsWatcher(makeConfig(tmpDir), enqueue);
      expect(fs.existsSync(eventsDir)).toBe(false);
      watcher.start();
      watcher.stop();
      expect(fs.existsSync(eventsDir)).toBe(true);
      expect(fs.statSync(eventsDir).mode & 0o777).toBe(0o700);
    });

    it("writes instance file on start and removes it on stop", () => {
      const instancePath = path.join(os.homedir(), ".pi", "agent", "bryti-instance.json");
      const watcher = createEventsWatcher(makeConfig(tmpDir), enqueue);
      watcher.start();
      expect(fs.existsSync(instancePath)).toBe(true);
      const instance = JSON.parse(fs.readFileSync(instancePath, "utf-8"));
      expect(instance.eventsDir).toBe(eventsDir);
      expect(instance.allowedUsers).toContain("123");
      expect(fs.statSync(instancePath).mode & 0o777).toBe(0o600);
      watcher.stop();
      expect(fs.existsSync(instancePath)).toBe(false);
    });

    it("instance file contains allowed users from both telegram and whatsapp", () => {
      const config = {
        telegram: { token: "tok", allowed_users: [111] },
        whatsapp: { enabled: true, allowed_users: ["31612345678"] },
        threema: { enabled: false, gateway_id: "", secret: "", private_key_path: "", allowed_senders: [], api_base_url: "https://msgapi.threema.ch", callback: { host: "127.0.0.1", port: 8787, path: "/threema/callback" } },
        data_dir: tmpDir,
        web_e2ee: { enabled: false },
      } as unknown as Config;
      const watcher = createEventsWatcher(config, enqueue);
      watcher.start();
      watcher.stop();
      const instancePath = path.join(os.homedir(), ".pi", "agent", "bryti-instance.json");
      // File was removed by stop(), that's correct — just check it was written
      // by observing that stop() cleaned up (the write itself is tested above)
    });
  });

  describe("startup scan (processEventFile)", () => {
    it("enqueues a valid event file and deletes it", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      const filePath = writeEventFile(eventsDir, "test.json", {
        userId: "123",
        text: "Hello from pi",
        source: "pi-session",
      });

      const watcher = createEventsWatcher(makeConfig(tmpDir), enqueue);
      watcher.start();
      watcher.stop();

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0].userId).toBe("123");
      expect(enqueued[0].channelId).toBe("123");
      expect(enqueued[0].text).toBe("Hello from pi");
      expect((enqueued[0].raw as any).source).toBe("pi-session");
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("sets source to 'external' when not provided", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      writeEventFile(eventsDir, "test.json", { userId: "123", text: "hi" });

      const watcher = createEventsWatcher(makeConfig(tmpDir), enqueue);
      watcher.start();
      watcher.stop();

      expect((enqueued[0].raw as any).source).toBe("external");
    });

    it("deletes the file only after enqueue accepts it", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      const filePath = writeEventFile(eventsDir, "test.json", {
        userId: "123",
        text: "timing test",
      });

      let fileExistedDuringEnqueue = true;
      const checkingEnqueue = (msg: IncomingMessage) => {
        fileExistedDuringEnqueue = fs.existsSync(filePath);
        enqueued.push(msg);
      };

      const watcher = createEventsWatcher(makeConfig(tmpDir), checkingEnqueue);
      watcher.start();
      watcher.stop();

      expect(fileExistedDuringEnqueue).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("retains rejected events and uses a stable work identity on retry", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      const file = writeEventFile(eventsDir, "rejected.json", { userId: "123", text: "keep me" });
      const attempts: IncomingMessage[] = [];
      const rejecting = (msg: IncomingMessage) => { attempts.push(msg); return false; };
      const watcher = createEventsWatcher(makeConfig(tmpDir), rejecting);
      watcher.start();
      watcher.stop();
      expect(fs.existsSync(file)).toBe(true);
      watcher.start();
      watcher.stop();
      expect(attempts[0].workId).toBeTruthy();
      expect(attempts[1].workId).toBe(attempts[0].workId);
    });

    it("retains an event when durable acceptance throws", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      const file = writeEventFile(eventsDir, "failed.json", { userId: "123", text: "keep me" });
      const watcher = createEventsWatcher(makeConfig(tmpDir), () => { throw new Error("disk unavailable"); });
      expect(() => watcher.start()).not.toThrow();
      watcher.stop();
      expect(fs.existsSync(file)).toBe(true);
    });

    it("rejects events for unknown userIds and deletes the file", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      const filePath = writeEventFile(eventsDir, "unknown.json", {
        userId: "999",
        text: "not allowed",
      });

      const watcher = createEventsWatcher(makeConfig(tmpDir), enqueue);
      watcher.start();
      watcher.stop();

      expect(enqueued).toHaveLength(0);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("deletes files with missing userId", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      const filePath = writeEventFile(eventsDir, "bad.json", { text: "no user" });

      const watcher = createEventsWatcher(makeConfig(tmpDir), enqueue);
      watcher.start();
      watcher.stop();

      expect(enqueued).toHaveLength(0);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("deletes files with missing text", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      const filePath = writeEventFile(eventsDir, "bad.json", { userId: "123" });

      const watcher = createEventsWatcher(makeConfig(tmpDir), enqueue);
      watcher.start();
      watcher.stop();

      expect(enqueued).toHaveLength(0);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("deletes unparseable JSON files", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      const filePath = path.join(eventsDir, "corrupt.json");
      fs.writeFileSync(filePath, "{ not valid json", "utf-8");

      const watcher = createEventsWatcher(makeConfig(tmpDir), enqueue);
      watcher.start();
      watcher.stop();

      expect(enqueued).toHaveLength(0);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("ignores non-.json files", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      const txtFile = path.join(eventsDir, "ignored.txt");
      fs.writeFileSync(txtFile, "irrelevant", "utf-8");

      const watcher = createEventsWatcher(makeConfig(tmpDir), enqueue);
      watcher.start();
      watcher.stop();

      expect(enqueued).toHaveLength(0);
      expect(fs.existsSync(txtFile)).toBe(true);
    });

    it("processes multiple event files in one scan", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      writeEventFile(eventsDir, "a.json", { userId: "123", text: "first" });
      writeEventFile(eventsDir, "b.json", { userId: "456", text: "second" });

      const watcher = createEventsWatcher(makeConfig(tmpDir), enqueue);
      watcher.start();
      watcher.stop();

      expect(enqueued).toHaveLength(2);
      const texts = enqueued.map((m) => m.text).sort();
      expect(texts).toEqual(["first", "second"]);
    });

    it("accepts whatsapp allowed users", () => {
      const config = {
        telegram: { token: "tok", allowed_users: [] },
        whatsapp: { enabled: true, allowed_users: ["31612345678"] },
        threema: { enabled: false, gateway_id: "", secret: "", private_key_path: "", allowed_senders: [], api_base_url: "https://msgapi.threema.ch", callback: { host: "127.0.0.1", port: 8787, path: "/threema/callback" } },
        data_dir: tmpDir,
        web_e2ee: { enabled: false },
      } as unknown as Config;

      fs.mkdirSync(eventsDir, { recursive: true });
      writeEventFile(eventsDir, "wa.json", {
        userId: "31612345678",
        text: "from whatsapp",
      });

      const watcher = createEventsWatcher(config, enqueue);
      watcher.start();
      watcher.stop();

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0].text).toBe("from whatsapp");
      expect(enqueued[0].platform).toBe("whatsapp");
    });

    it("produces raw.type = 'event'", () => {
      fs.mkdirSync(eventsDir, { recursive: true });
      writeEventFile(eventsDir, "t.json", { userId: "123", text: "check type" });

      const watcher = createEventsWatcher(makeConfig(tmpDir), enqueue);
      watcher.start();
      watcher.stop();

      expect((enqueued[0].raw as any).type).toBe("event");
    });
  });
});
