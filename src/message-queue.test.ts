import { describe, it, expect, vi, beforeEach } from "vitest";
import { MessageQueue } from "./message-queue.js";
import type { IncomingMessage } from "./channels/types.js";

function makeMsg(text: string, channelId = "chan1"): IncomingMessage {
  return { text, channelId, userId: "user1", platform: "telegram", raw: null };
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
    let release!: () => void;
    let calls = 0;
    const controlled = vi.fn(async (msg: IncomingMessage) => {
      calls += 1;
      processed.push(msg);
      if (calls === 1) {
        await new Promise<void>((res) => { release = res; });
      }
    });

    const q = new MessageQueue(controlled, rejectFn);
    q.enqueue(makeMsg("first"));
    q.enqueue(makeMsg("second"));

    await vi.waitUntil(() => calls === 1);
    expect(processed).toHaveLength(1);
    expect(q.isProcessing("chan1")).toBe(true);

    release();
    await vi.waitUntil(() => processed.length === 2);
    expect(processed[1].text).toBe("second");
  });

  it("rejects messages when queue is full", async () => {
    let release!: () => void;
    const blocked = vi.fn(async () => {
      await new Promise<void>((res) => { release = res; });
    });

    const maxDepth = 3;
    const q = new MessageQueue(blocked, rejectFn, maxDepth);

    q.enqueue(makeMsg("msg0"));
    await vi.waitUntil(() => blocked.mock.calls.length === 1);

    q.enqueue(makeMsg("msg1"));
    q.enqueue(makeMsg("msg2"));
    q.enqueue(makeMsg("msg3"));
    q.enqueue(makeMsg("overflow"));

    await vi.waitUntil(() => rejected.length >= 1);
    expect(rejected[0].text).toBe("overflow");

    release();
  });

  it("merges messages within the merge window", async () => {
    const q = new MessageQueue(processFn, rejectFn, MAX_DEPTH_DEFAULT, 5000);

    q.enqueue(makeMsg("part one"));
    q.enqueue(makeMsg("part two"));
    q.enqueue(makeMsg("part three"));

    await vi.waitUntil(() => processed.length >= 1, { timeout: 2000 });

    const merged = processed.map((m) => m.text).join(" ");
    expect(merged).toContain("part one");
    expect(merged).toContain("part two");
    expect(merged).toContain("part three");
  });

  it("does not merge messages outside the merge window", async () => {
    const q = new MessageQueue(processFn, rejectFn, 10, 0);

    q.enqueue(makeMsg("alpha"));
    q.enqueue(makeMsg("beta"));

    await vi.waitUntil(() => processed.length === 2, { timeout: 2000 });

    expect(processed[0].text).toBe("alpha");
    expect(processed[1].text).toBe("beta");
  });

  it("preserves audio attachments when merging messages", () => {
    const q = new MessageQueue(processFn, rejectFn, MAX_DEPTH_DEFAULT, 5000);
    const merged = (q as any).mergeEntries([
      {
        msg: {
          ...makeMsg("voice"),
          audio: [{ path: "/tmp/voice.ogg", mimeType: "audio/ogg", durationSeconds: 3 }],
          replyMode: "voice",
        },
        arrivedAt: 0,
      },
      { msg: makeMsg("caption"), arrivedAt: 1 },
    ]) as IncomingMessage;

    expect(merged.audio).toEqual([
      { path: "/tmp/voice.ogg", mimeType: "audio/ogg", durationSeconds: 3 },
    ]);
    expect(merged.text).toBe("voice\ncaption");
  });

  it("preserves voice reply mode when merging messages", () => {
    const q = new MessageQueue(processFn, rejectFn, MAX_DEPTH_DEFAULT, 5000);
    const merged = (q as any).mergeEntries([
      { msg: makeMsg("text"), arrivedAt: 0 },
      { msg: { ...makeMsg("voice"), replyMode: "voice" }, arrivedAt: 1 },
    ]) as IncomingMessage;

    expect(merged.replyMode).toBe("voice");
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

  it("isolates Telegram topics within the same group", async () => {
    let releaseTopic!: () => void;
    const controlled = vi.fn(async (msg: IncomingMessage) => {
      processed.push(msg);
      if (msg.channelThreadId === "32") {
        await new Promise<void>((resolve) => {
          releaseTopic = resolve;
        });
      }
    });
    const q = new MessageQueue(controlled, rejectFn);

    q.enqueue({ ...makeMsg("long task", "group"), channelThreadId: "32" });
    await vi.waitUntil(() => controlled.mock.calls.length === 1);
    q.enqueue({ ...makeMsg("other topic", "group"), channelThreadId: "48" });

    await vi.waitUntil(() => processed.length === 2, { timeout: 2000 });
    expect(processed[1].text).toBe("other topic");

    releaseTopic();
  });
});

const MAX_DEPTH_DEFAULT = 10;
