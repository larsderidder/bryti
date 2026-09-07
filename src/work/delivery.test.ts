import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableOutboundBridge } from "../channels/outbound-queue.js";
import { deliveryNotSent } from "../channels/delivery.js";
import type { ChannelBridge } from "../channels/types.js";
import { createWorkStore } from "./store.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-response-receipt-"));
  directories.push(dir);
  const store = createWorkStore(dir);
  const { record } = store.accept({ userId: "u", channelId: "u", platform: "telegram", text: "Do the work", raw: null });
  store.claim([record.id]);
  const inner = {
    platform: "telegram", name: "test", start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => "sent"),
  } as unknown as ChannelBridge;
  return { dir, store, record, inner };
}

describe("response handoff receipts", () => {
  it("acknowledges execution only after the final response is durably staged", async () => {
    const { dir, store, record, inner } = setup();
    const snapshots: Array<{ state: string; execution?: string; persisted: boolean }> = [];
    const bridge = new DurableOutboundBridge(inner, dir, {
      onOutcome: (event) => {
        snapshots.push({ state: event.state, execution: store.get(record.id)?.execution,
          persisted: fs.readdirSync(path.join(dir, "pending", "outbound", "telegram")).some((file) => file.endsWith(".json")) });
        store.recordResponse(event.workIds, event.state, event.error);
      },
    });
    vi.mocked(inner.sendMessage).mockImplementation(async () => {
      expect(fs.readdirSync(path.join(dir, "pending", "outbound", "telegram")).some((file) => file.endsWith(".json"))).toBe(true);
      return "sent";
    });
    try {
      await bridge.sendMessage("u", "Final response", { workIds: [record.id] });
      expect(store.get(record.id)).toMatchObject({ execution: "completed", delivery: "delivered" });
      expect(snapshots).toEqual([
        { state: "pending", execution: "running", persisted: true },
        { state: "delivered", execution: "completed", persisted: true },
      ]);
    } finally {
      await bridge.stop();
      store.close();
    }
  });

  it("recovers a staged response whose execution acknowledgement was interrupted", async () => {
    const { dir, store, record, inner } = setup();
    vi.mocked(inner.sendMessage).mockRejectedValue(deliveryNotSent("offline", { retryable: true }));
    const first = new DurableOutboundBridge(inner, dir, {
      baseBackoffMs: 60_000,
      onOutcome: () => { throw new Error("receipt temporarily unavailable"); },
    });
    await expect(first.sendMessage("u", "Final response", { workIds: [record.id] })).rejects.toThrow();
    await first.stop();
    store.recover();
    expect(store.get(record.id)?.execution).toBe("interrupted");
    vi.mocked(inner.sendMessage).mockClear();
    const recovered = new DurableOutboundBridge(inner, dir, {
      onOutcome: (event) => store.recordResponse(event.workIds, event.state, event.error),
    });
    try {
      await recovered.start();
      expect(store.get(record.id)).toMatchObject({ execution: "completed", delivery: "pending" });
      expect(inner.sendMessage).not.toHaveBeenCalled();
    } finally {
      await recovered.stop();
      store.close();
    }
  });
});
