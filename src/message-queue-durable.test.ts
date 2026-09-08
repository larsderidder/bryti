import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageQueue } from "./message-queue.js";
import { createWorkStore, type WorkStore } from "./work/store.js";
import type { IncomingMessage } from "./channels/types.js";

const message: IncomingMessage = { userId: "u", channelId: "c", platform: "telegram", text: "hello", raw: null };

describe("durable message queue", () => {
  let dir: string;
  let store: WorkStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-queue-durable-"));
    store = createWorkStore(dir);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists accepted messages while startup is paused and resumes them once", async () => {
    const process = vi.fn(async () => {});
    const queue = new MessageQueue(process, vi.fn(), 10, 5000, () => "main", { store, paused: true });
    expect(queue.enqueue({ ...message, messageId: "1" })).toBe(true);
    expect(store.queued()).toHaveLength(1);
    expect(process).not.toHaveBeenCalled();
    queue.start();
    queue.start();
    await queue.waitForIdle();
    expect(process).toHaveBeenCalledOnce();
    expect(store.queued()).toEqual([]);
  });

  it("replays only queued messages from a previous instance", async () => {
    const first = new MessageQueue(vi.fn(), vi.fn(), 10, 5000, () => "main", { store, paused: true });
    first.enqueue(message);
    first.stop();
    store.close();
    store = createWorkStore(dir);
    store.recover();
    const process = vi.fn(async () => {});
    const second = new MessageQueue(process, vi.fn(), 10, 5000, () => "main", { store, paused: true });
    second.start();
    await second.waitForIdle();
    expect(process).toHaveBeenCalledOnce();
  });

  it("marks all merged receipts completed without merging unrelated destinations", async () => {
    const queue = new MessageQueue(vi.fn(async () => {}), vi.fn(), 10, 5000, () => "main", { store, paused: true });
    queue.enqueue({ ...message, workId: "one" });
    queue.enqueue({ ...message, workId: "two" });
    queue.start();
    await queue.waitForIdle();
    expect(store.get("one")?.execution).toBe("completed");
    expect(store.get("two")?.execution).toBe("completed");
    expect(store.get("one")?.message.workIds).toEqual(["one", "two"]);
    expect(store.get("two")?.message.workIds).toEqual(["one", "two"]);
  });

  it("does not create a receipt for rejected work", () => {
    const queue = new MessageQueue(vi.fn(async () => {}), vi.fn(async () => {}), 1, 5000, () => "main", { store, paused: true });
    queue.enqueue({ ...message, workId: "one" });
    expect(queue.enqueue({ ...message, workId: "two" })).toBe(false);
    expect(store.get("two")).toBeNull();
  });

  it("does not turn a caught processing failure into completed work", async () => {
    const queue = new MessageQueue(async (msg) => {
      store.finish(msg.workIds!, "failed", "Model failed");
    }, vi.fn(), 10, 5000, () => "main", { store });
    queue.enqueue({ ...message, workId: "failure" });
    await queue.waitForIdle();
    expect(store.get("failure")?.execution).toBe("failed");
  });

  it("retains unclaimed work when another consumer already owns part of a merged batch", async () => {
    const process = vi.fn(async () => {});
    const queue = new MessageQueue(process, vi.fn(async () => {}), 10, 5000, () => "main", { store, paused: true });
    queue.enqueue({ ...message, workId: "one" });
    queue.enqueue({ ...message, workId: "two" });
    store.claim(["one"]);
    queue.start();
    await queue.waitForIdle();
    expect(store.get("one")?.execution).toBe("running");
    expect(store.get("two")?.execution).toBe("completed");
    expect(process).toHaveBeenCalledOnce();
  });

  it("restores older accepted work before messages received during startup", async () => {
    store.accept({ ...message, threadId: "main", text: "older request", workId: "old" });
    const order: string[] = [];
    const queue = new MessageQueue(async (msg) => { order.push(msg.text); }, vi.fn(), 10, 5000, () => "main", { store, paused: true });
    queue.enqueue({ ...message, text: "/clear", workId: "new" });
    queue.start();
    await queue.waitForIdle();
    expect(order).toEqual(["older request", "/clear"]);
  });
});
