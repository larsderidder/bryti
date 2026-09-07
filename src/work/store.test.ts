import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "../channels/types.js";
import { createWorkStore, type WorkStore } from "./store.js";

const message: IncomingMessage = {
  userId: "user", channelId: "chat", platform: "telegram", text: "hello", raw: null,
};

describe("durable work receipts", () => {
  let dir: string;
  let store: WorkStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-work-"));
    store = createWorkStore(dir);
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists accepted work and deduplicates platform message IDs", () => {
    const first = store.accept({ ...message, messageId: "42" });
    expect(first.created).toBe(true);
    store.close();
    store = createWorkStore(dir);
    const replay = store.accept({ ...message, messageId: "42" });
    expect(replay.created).toBe(false);
    expect(replay.record.id).toBe(first.record.id);
    expect(store.queued()).toHaveLength(1);
    expect(store.accept({ ...message, channelId: "other", messageId: "42" }).created).toBe(true);
  });

  it("claims a batch atomically and never claims the same work twice", () => {
    const first = store.accept(message).record;
    const second = store.accept(message).record;
    expect(store.claim([first.id])).toBe(true);
    expect(store.claim([second.id, first.id])).toBe(false);
    expect(store.get(second.id)?.execution).toBe("queued");
  });

  it("recovers queued work but marks started work interrupted without replay", () => {
    const waiting = store.accept(message).record;
    const active = store.accept(message).record;
    store.claim([active.id]);
    store.close();
    store = createWorkStore(dir);
    const recovered = store.recover();
    expect(recovered.queued.map((entry) => entry.id)).toEqual([waiting.id]);
    expect(recovered.interrupted.map((entry) => entry.id)).toEqual([active.id]);
    expect(store.get(active.id)?.execution).toBe("interrupted");
    // Keep interrupted work discoverable if a crash prevented its recovery notice.
    expect(store.recover().interrupted.map((entry) => entry.id)).toEqual([active.id]);
  });

  it("tracks execution separately from deferred delivery", () => {
    const { id } = store.accept(message).record;
    store.claim([id]);
    store.recordDelivery([id], "pending");
    store.finish([id], "completed");
    expect(store.get(id)).toMatchObject({ execution: "completed", delivery: "pending" });
    store.recordDelivery([id], "delivered");
    expect(store.get(id)).toMatchObject({ execution: "completed", delivery: "delivered" });
  });

  it("does not turn interrupted execution into success on a late completion", () => {
    const { id } = store.accept(message).record;
    store.claim([id]);
    store.finish([id], "interrupted");
    store.finish([id], "completed");
    expect(store.get(id)?.execution).toBe("interrupted");
  });

  it("does not persist raw platform objects or untrusted receipt aliases", () => {
    const record = store.accept({ ...message, raw: { type: "message", private: "platform-data" }, workIds: ["other"] }).record;
    expect(record.message.raw).toBeNull();
    expect(record.message.workIds).toEqual([record.id]);
  });

  it("rejects identity reuse for a different owner or destination", () => {
    store.accept({ ...message, workId: "occurrence:42" });
    expect(() => store.accept({ ...message, workId: "occurrence:42", userId: "another" })).toThrow("identity");
  });

  it("retains interrupted work as visible even if its notification fails", () => {
    const { id } = store.accept(message).record;
    store.claim([id]);
    store.recover();
    expect(store.listUnresolved().map((record) => record.id)).toContain(id);
  });

  it("marks response handoff gaps unknown on restart until a delivery record confirms them", () => {
    const { id } = store.accept(message).record;
    store.claim([id]);
    store.recordDelivery([id], "pending");
    store.finish([id], "completed");
    store.recover();
    expect(store.get(id)).toMatchObject({ execution: "completed", delivery: "unknown" });
    store.recordDelivery([id], "delivered");
    expect(store.get(id)?.delivery).toBe("delivered");
  });

  it("does not let a recovered failed voice attempt overwrite a delivered text fallback", () => {
    const { id } = store.accept(message).record;
    store.recordDelivery([id], "delivered");
    store.recordDelivery([id], "failed");
    store.recordDelivery([id], "pending");
    expect(store.get(id)?.delivery).toBe("delivered");
  });
});
