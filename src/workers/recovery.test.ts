import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWorkerOwner, collectWorkerEvents, acknowledgeWorkerEvent } from "./recovery.js";

const target = { userId: "u", channelId: "chat", platform: "telegram" as const, threadId: "topic", channelThreadId: "7" };

describe("worker recovery", () => {
  let dir: string;
  let workerDir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-worker-recovery-"));
    workerDir = path.join(dir, "files", "workers", "w-12345678");
    fs.mkdirSync(workerDir, { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("marks abandoned workers interrupted and retains their originating destination", () => {
    registerWorkerOwner(dir, "w-12345678", target);
    fs.writeFileSync(path.join(workerDir, "status.json"), JSON.stringify({ status: "running", worker_id: "w-12345678" }));
    const events = collectWorkerEvents(dir, true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ...target, workId: "worker:w-12345678:interrupted" });
    expect(JSON.parse(fs.readFileSync(path.join(workerDir, "status.json"), "utf8")).status).toBe("interrupted");
  });

  it("does not interrupt live workers during the periodic completion scan", () => {
    registerWorkerOwner(dir, "w-12345678", target);
    fs.writeFileSync(path.join(workerDir, "status.json"), JSON.stringify({ status: "running", worker_id: "w-12345678" }));
    expect(collectWorkerEvents(dir)).toEqual([]);
  });

  it("uses deterministic notification identities so queue receipts deduplicate recovery", () => {
    registerWorkerOwner(dir, "w-12345678", target);
    fs.writeFileSync(path.join(workerDir, "status.json"), JSON.stringify({ status: "complete", worker_id: "w-12345678" }));
    const first = collectWorkerEvents(dir);
    expect(collectWorkerEvents(dir)[0].workId).toBe(first[0].workId);
  });

  it("does not trust destination fields from the worker writable directory", () => {
    registerWorkerOwner(dir, "w-12345678", target);
    fs.writeFileSync(path.join(workerDir, "status.json"), JSON.stringify({ status: "complete", userId: "attacker", channelId: "other" }));
    expect(collectWorkerEvents(dir)[0].channelId).toBe("chat");
  });

  it("retires owner records after durable acceptance without removing worker results", () => {
    registerWorkerOwner(dir, "w-12345678", target);
    fs.writeFileSync(path.join(workerDir, "status.json"), JSON.stringify({ status: "complete" }));
    const event = collectWorkerEvents(dir)[0];
    acknowledgeWorkerEvent(dir, event.workId!);
    expect(collectWorkerEvents(dir)).toEqual([]);
    expect(fs.existsSync(path.join(workerDir, "status.json"))).toBe(true);
  });
});
