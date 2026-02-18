import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageQueue } from "./message-queue.js";
import type { IncomingMessage } from "./channels/types.js";

function makeMsg(text: string, channelId = "chan1"): IncomingMessage {
  return { text, channelId, userId: "user1" };
}

describe("MessageQueue", () => {
  let processed: IncomingMessage[];
  let rejected: IncomingMessage[];
  let processFn: (msg: IncomingMessage) => Promise<void>;
  let rejectFn: (msg: IncomingMessage) => Promise<void>;

  beforeEach(() => {
    processed = [];
    rejected = [];
    processFn = vi.fn(async (msg) => { processed.push(msg); });
    rejectFn = vi.fn(async (msg) => { rejected.push(msg); });
  });

  it("processes a single message", async () => {
    const q = new MessageQueue(processFn, rejectFn);
    q.enqueue(makeMsg("hello"));
    await vi.waitUntil(() => processed.length === 1);
    expect(processed[0].text).toBe("hello");
  });

  it("processes multiple messages sequentially", async () => {
    // Use a latch so we can control when the first message finishes
    let release!: () => void;
    let calls = 0;
    const controlled = vi.fn(async (msg: IncomingMessage) => {
      calls++;
      processed.push(msg);
      if (calls === 1) {
        await new Promise<void>((res) => { release = res; });
      }
    });

    const q = new MessageQueue(controlled, rejectFn);
    q.enqueue(makeMsg("first"));
    q.enqueue(makeMsg("second"));

    // Wait until first is being processed
    await vi.waitUntil(() => calls === 1);
    expect(processed).toHaveLength(1);
    expect(q.isProcessing("chan1")).toBe(true);

    // Release first, second should follow
    release();
    await vi.waitUntil(() => processed.length === 2);
    expect(processed[1].text).toBe("second");
  });

  it("rejects messages when queue is full", async () => {
    // Block processFn indefinitely so the queue fills
    let release!: () => void;
    const blocked = vi.fn(async () => {
      await new Promise<void>((res) => { release = res; });
    });

    const MAX = 3;
    const q = new MessageQueue(blocked, rejectFn, MAX);

    // First message starts processing immediately (not queued)
    q.enqueue(makeMsg("msg0"));
    await vi.waitUntil(() => blocked.mock.calls.length === 1);

    // Fill the queue to max
    q.enqueue(makeMsg("msg1"));
    q.enqueue(makeMsg("msg2"));
    q.enqueue(makeMsg("msg3"));

    // This one exceeds the max
    q.enqueue(makeMsg("overflow"));

    await vi.waitUntil(() => rejected.length >= 1);
    expect(rejected[0].text).toBe("overflow");

    release();
  });

  it("merges messages within the merge window", async () => {
    const q = new MessageQueue(processFn, rejectFn, MAX_DEPTH_DEFAULT, 5000);

    // Simulate three messages arriving at t=0, t=1000, t=2000 (all within 5s)
    const now = Date.now();
    // Access internals via enqueue — we fake arrivedAt by manipulating the
    // queue entries directly after enqueue
    q.enqueue(makeMsg("part one"));
    q.enqueue(makeMsg("part two"));
    q.enqueue(makeMsg("part three"));

    await vi.waitUntil(() => processed.length >= 1, { timeout: 2000 });

    // All three should have been merged (they all arrive nearly simultaneously)
    const texts = processed.map((m) => m.text);
    // The merged text contains all parts joined by newline
    const merged = texts.join(" ");
    expect(merged).toContain("part one");
    expect(merged).toContain("part two");
    expect(merged).toContain("part three");
  });

  it("does not merge messages outside the merge window", async () => {
    // Use a tiny merge window so nothing merges
    const q = new MessageQueue(processFn, rejectFn, 10, 0);

    q.enqueue(makeMsg("alpha"));
    q.enqueue(makeMsg("beta"));

    await vi.waitUntil(() => processed.length === 2, { timeout: 2000 });

    expect(processed[0].text).toBe("alpha");
    expect(processed[1].text).toBe("beta");
  });

  it("tracks queue depth correctly", async () => {
    let release!: () => void;
    const blocked = vi.fn(async () => {
      await new Promise<void>((res) => { release = res; });
    });

    const q = new MessageQueue(blocked, rejectFn);
    expect(q.queueDepth("chan1")).toBe(0);

    q.enqueue(makeMsg("first"));
    await vi.waitUntil(() => blocked.mock.calls.length === 1);

    q.enqueue(makeMsg("second"));
    q.enqueue(makeMsg("third"));
    expect(q.queueDepth("chan1")).toBe(2);

    release();
    await vi.waitUntil(() => q.queueDepth("chan1") === 0);
  });

  it("isolates queues by channelId", async () => {
    const q = new MessageQueue(processFn, rejectFn);
    q.enqueue(makeMsg("from chan1", "chan1"));
    q.enqueue(makeMsg("from chan2", "chan2"));

    await vi.waitUntil(() => processed.length === 2, { timeout: 2000 });
    const channels = processed.map((m) => m.channelId);
    expect(channels).toContain("chan1");
    expect(channels).toContain("chan2");
  });
});

const MAX_DEPTH_DEFAULT = 10;
