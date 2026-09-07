import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryError, isUnknownDeliveryError } from "./delivery.js";
import { DurableOutboundBridge, withDurableOutbound } from "./outbound-queue.js";
import type { ApprovalResult, ChannelBridge, IncomingMessage, Platform, SendOpts } from "./types.js";

type SendCall = { channelId: string; text: string; opts?: SendOpts };
type TestSendOpts = SendOpts & { workIds?: string[]; caption?: string };
type Deferred = { promise: Promise<string>; resolve: (value: string) => void; reject: (error: unknown) => void };

function createDeferred(): Deferred {
  let resolve!: (value: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

class FakeBridge implements ChannelBridge {
  readonly name = "fake";
  readonly platform: Platform = "telegram";
  sent: SendCall[] = [];
  voiceSent: Array<{ channelId: string; audioPath: string; opts?: SendOpts & { caption?: string } }> = [];
  stopped = false;
  nextError: unknown = null;
  nextDeferred: Deferred | null = null;
  nextVoiceError: unknown = null;
  nextVoiceDeferred: Deferred | null = null;

  async start() {}
  async stop() {
    this.stopped = true;
  }
  onMessage(_handler: (msg: IncomingMessage) => Promise<void>) {}
  async editMessage() {}
  async sendTyping() {}
  async sendApprovalRequest(): Promise<ApprovalResult> { return "deny"; }

  async sendMessage(channelId: string, text: string, opts?: SendOpts): Promise<string> {
    this.sent.push({ channelId, text, opts });
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    if (this.nextDeferred) {
      const deferred = this.nextDeferred;
      this.nextDeferred = null;
      return await deferred.promise;
    }
    return `msg-${this.sent.length}`;
  }

  async sendVoice(channelId: string, audioPath: string, opts?: SendOpts & { caption?: string }): Promise<string> {
    this.voiceSent.push({ channelId, audioPath, opts });
    if (this.nextVoiceError) {
      const error = this.nextVoiceError;
      this.nextVoiceError = null;
      throw error;
    }
    if (this.nextVoiceDeferred) {
      const deferred = this.nextVoiceDeferred;
      this.nextVoiceDeferred = null;
      return await deferred.promise;
    }
    return `voice-${this.voiceSent.length}`;
  }
}

class TextOnlyBridge extends FakeBridge {
  sendVoice = undefined;
}

describe("DurableOutboundBridge", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    vi.useRealTimers();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = null;
  });

  function make(options: ConstructorParameters<typeof DurableOutboundBridge>[2] = {}) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-outbound-test-"));
    const inner = new FakeBridge();
    const outcomes: Array<{ workIds: string[]; state: string; error?: string }> = [];
    const bridge = new DurableOutboundBridge(inner, tmpDir, {
      drainIntervalMs: 30_000,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
      ...options,
      onOutcome: (event) => {
        outcomes.push(event);
      },
    });
    return { inner, bridge, outcomes };
  }

  function queueDir(): string {
    return path.join(tmpDir!, "pending", "outbound", "telegram");
  }

  function records(): Array<Record<string, unknown>> {
    if (!fs.existsSync(queueDir())) {
      return [];
    }
    return fs.readdirSync(queueDir())
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(fs.readFileSync(path.join(queueDir(), file), "utf-8")) as Record<string, unknown>)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function writeRecord(record: Record<string, unknown>): void {
    fs.mkdirSync(queueDir(), { recursive: true });
    fs.writeFileSync(path.join(queueDir(), `${record.id}.json`), JSON.stringify(record));
  }

  it.each([0, 8])("preserves legacy records with %i attempts as unknown without resending", async (attempts) => {
    const { inner, bridge, outcomes } = make();
    const legacy = {
      id: "11111111-1111-4111-8111-111111111111", platform: "telegram", channelId: "chat",
      text: "Legacy reply", attempts, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    writeRecord(legacy);
    try {
      await bridge.start();
      await bridge.drain();
      expect(inner.sent).toEqual([]);
      expect(records()).toEqual([expect.objectContaining({ ...legacy, kind: "message", state: "unknown", workIds: [] })]);
      expect(outcomes).toEqual([{ workIds: [], state: "unknown", error: "legacy_delivery_unknown" }]);
    } finally {
      await bridge.stop();
    }
  });

  it("records pending and delivered states around a successful send", async () => {
    const { bridge, outcomes } = make();
    await bridge.start();

    const messageId = await bridge.sendMessage("123", "hello", { workIds: ["work-1"] } as TestSendOpts);
    await vi.waitUntil(() => records()[0]?.outcomeNotifiedAt != null, { timeout: 1000, interval: 1 });

    expect(messageId).toBe("msg-1");
    expect(records()).toMatchObject([{ kind: "message", state: "delivered", messageId: "msg-1", workIds: ["work-1"] }]);
    expect(outcomes).toEqual([
      { workIds: ["work-1"], state: "pending" },
      { workIds: ["work-1"], state: "delivered" },
    ]);
    await bridge.stop();
  });

  it("does not drain a direct send record while the provider call is still in flight", async () => {
    vi.useFakeTimers();
    const { inner, bridge } = make();
    await bridge.start();
    const deferred = createDeferred();
    inner.nextDeferred = deferred;

    const sendPromise = bridge.sendMessage("123", "slow", { workIds: ["slow-work"] } as TestSendOpts);
    await vi.waitUntil(() => inner.sent.length === 1, { timeout: 1000, interval: 1 });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(inner.sent).toHaveLength(1);
    expect(records()).toMatchObject([{ state: "sending", workIds: ["slow-work"] }]);

    deferred.resolve("slow-message");
    await expect(sendPromise).resolves.toBe("slow-message");
    expect(inner.sent).toHaveLength(1);
    expect(records()).toMatchObject([{ state: "delivered", messageId: "slow-message" }]);
    await bridge.stop();
  });

  it("marks interrupted sending records unknown on restart without replaying them", async () => {
    const { inner, bridge, outcomes } = make();
    writeRecord({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "message",
      platform: "telegram",
      channelId: "123",
      text: "maybe sent",
      attempts: 1,
      state: "sending",
      workIds: ["interrupted-work"],
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:01.000Z",
    });

    await bridge.start();

    expect(inner.sent).toEqual([]);
    expect(records()).toMatchObject([{ state: "unknown", lastError: "interrupted_send", workIds: ["interrupted-work"] }]);
    expect(outcomes).toEqual([{ workIds: ["interrupted-work"], state: "unknown", error: "interrupted_send" }]);
    await bridge.stop();
  });

  it("re-emits unnotified terminal outcomes on startup without resending", async () => {
    const { inner, bridge, outcomes } = make();
    writeRecord({
      id: "22222222-2222-4222-8222-222222222222",
      kind: "message",
      platform: "telegram",
      channelId: "123",
      text: "already sent",
      attempts: 1,
      state: "delivered",
      messageId: "msg-old",
      workIds: ["receipt-work"],
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:01.000Z",
    });

    await bridge.start();
    await vi.waitUntil(() => records()[0]?.outcomeNotifiedAt != null, { timeout: 1000, interval: 1 });

    expect(inner.sent).toEqual([]);
    expect(outcomes).toEqual([{ workIds: ["receipt-work"], state: "delivered" }]);
    await bridge.stop();
  });

  it("does not mark terminal outcomes notified when the callback fails", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-outbound-test-"));
    const inner = new FakeBridge();
    const bridge = new DurableOutboundBridge(inner, tmpDir, {
      onOutcome: () => {
        throw new Error("receipt store down");
      },
    });

    await bridge.start();
    await expect(bridge.sendMessage("123", "hello")).resolves.toBe("msg-1");

    expect(records()).toMatchObject([{ state: "delivered" }]);
    expect(records()[0].outcomeNotifiedAt).toBeUndefined();
    await bridge.stop();
  });

  it("stop waits for active sends before stopping the inner bridge", async () => {
    const { inner, bridge } = make();
    await bridge.start();
    const deferred = createDeferred();
    inner.nextDeferred = deferred;
    const sendPromise = bridge.sendMessage("123", "slow");
    await vi.waitUntil(() => inner.sent.length === 1, { timeout: 1000, interval: 1 });

    let stopped = false;
    const stopPromise = bridge.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    expect(inner.stopped).toBe(false);

    deferred.resolve("slow-message");
    await sendPromise;
    await stopPromise;

    expect(stopped).toBe(true);
    expect(inner.stopped).toBe(true);
  });


  it("stop waits for active drain sends before stopping the inner bridge", async () => {
    vi.useFakeTimers();
    const { inner, bridge } = make();
    await bridge.start();
    writeRecord({
      id: "44444444-4444-4444-8444-444444444444",
      kind: "message",
      platform: "telegram",
      channelId: "123",
      text: "drain slow",
      attempts: 0,
      state: "pending",
      workIds: [],
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
    });
    const deferred = createDeferred();
    inner.nextDeferred = deferred;

    const timerPromise = vi.advanceTimersByTimeAsync(30_000);
    await vi.waitUntil(() => inner.sent.length === 1, { timeout: 1000, interval: 1 });
    let stopped = false;
    const stopPromise = bridge.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    expect(inner.stopped).toBe(false);

    deferred.resolve("drained-message");
    await timerPromise;
    await stopPromise;
    expect(stopped).toBe(true);
    expect(inner.stopped).toBe(true);
  });

  it("stop waits for active outcome callbacks", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-outbound-test-"));
    const inner = new FakeBridge();
    const callback = createDeferred();
    const bridge = new DurableOutboundBridge(inner, tmpDir, {
      onOutcome: (event) => {
        if (event.state === "delivered") {
          return callback.promise.then(() => undefined);
        }
      },
    });
    await bridge.start();
    await expect(bridge.sendMessage("123", "hello")).resolves.toBe("msg-1");

    let stopped = false;
    const stopPromise = bridge.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    callback.resolve("done");
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it("retries only typed retryable not-sent failures", async () => {
    vi.useFakeTimers();
    const { inner, bridge } = make({ maxAttempts: 2 });
    await bridge.start();
    inner.nextError = new DeliveryError("rate limited", { outcome: "not_sent", retryable: true });

    await expect(bridge.sendMessage("123", "retry me")).rejects.toMatchObject({ outcome: "not_sent", retryable: true });
    expect(records()).toMatchObject([{ state: "pending", attempts: 1, lastError: "retryable_not_sent", nextAttemptAt: expect.any(String) }]);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(inner.sent.map((call) => call.text)).toEqual(["retry me", "retry me"]);
    expect(records()).toMatchObject([{ state: "delivered", attempts: 2, messageId: "msg-2" }]);
    await bridge.stop();
  });

  it("records permanent not-sent failures and does not retry them", async () => {
    vi.useFakeTimers();
    const { inner, bridge, outcomes } = make({ maxAttempts: 2 });
    await bridge.start();
    inner.nextError = new DeliveryError("chat not found", { outcome: "not_sent", retryable: false });

    await expect(bridge.sendMessage("123", "doomed")).rejects.toMatchObject({ outcome: "not_sent", retryable: false });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(inner.sent).toHaveLength(1);
    expect(records()).toMatchObject([{ state: "failed", attempts: 1, lastError: "permanent_not_sent" }]);
    expect(outcomes.at(-1)).toEqual({ workIds: [], state: "failed", error: "permanent_not_sent" });
    await bridge.stop();
  });

  it("records arbitrary provider failures as terminal unknown and does not retry them", async () => {
    vi.useFakeTimers();
    const { inner, bridge } = make({ maxAttempts: 2 });
    await bridge.start();
    inner.nextError = new Error("socket timed out after write with token=secret");

    await expect(bridge.sendMessage("123", "ambiguous")).rejects.toSatisfy(isUnknownDeliveryError);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(inner.sent).toHaveLength(1);
    expect(records()).toMatchObject([{ state: "unknown", attempts: 1, lastError: "delivery_unknown" }]);
    expect(JSON.stringify(records())).not.toContain("secret");
    await bridge.stop();
  });

  it("fails exhausted retryable not-sent records visibly", async () => {
    vi.useFakeTimers();
    const { inner, bridge } = make({ maxAttempts: 1 });
    await bridge.start();
    inner.nextError = new DeliveryError("still rate limited", { outcome: "not_sent", retryable: true });

    await expect(bridge.sendMessage("123", "one shot")).rejects.toMatchObject({ outcome: "not_sent", retryable: true });

    expect(records()).toMatchObject([{ state: "failed", attempts: 1, lastError: "retryable_not_sent" }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(inner.sent).toHaveLength(1);
    await bridge.stop();
  });

  it("does not duplicate provider sends when the outcome callback fails", async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-outbound-test-"));
    const inner = new FakeBridge();
    const bridge = new DurableOutboundBridge(inner, tmpDir, {
      drainIntervalMs: 30_000,
      onOutcome: () => {
        throw new Error("receipt store down");
      },
    });

    await bridge.start();
    await expect(bridge.sendMessage("123", "hello")).resolves.toBe("msg-1");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(inner.sent).toHaveLength(1);
    expect(records()).toMatchObject([{ state: "delivered" }]);
    await bridge.stop();
  });

  it("persists voice delivery outcomes without deleting the caller-owned file", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-outbound-test-"));
    const inner = new FakeBridge();
    const outcomes: Array<{ workIds: string[]; state: string; error?: string }> = [];
    const wrapped = withDurableOutbound(inner, tmpDir, {
      onOutcome: (event) => {
        outcomes.push(event);
      },
    });
    const audioPath = path.join(tmpDir, "reply.ogg");
    fs.writeFileSync(audioPath, "voice");

    await expect(wrapped.sendVoice!("123", audioPath, { caption: "Reply", workIds: ["voice-work"] } as TestSendOpts)).resolves.toBe("voice-1");
    await vi.waitUntil(() => records()[0]?.outcomeNotifiedAt != null, { timeout: 1000, interval: 1 });

    expect(inner.voiceSent).toEqual([{ channelId: "123", audioPath, opts: { caption: "Reply", workIds: ["voice-work"] } }]);
    expect(fs.existsSync(audioPath)).toBe(true);
    expect(records()).toMatchObject([{ kind: "voice", state: "delivered", workIds: ["voice-work"], voiceFileName: "reply.ogg" }]);
    expect(outcomes).toEqual([
      { workIds: ["voice-work"], state: "pending" },
      { workIds: ["voice-work"], state: "delivered" },
    ]);
  });

  it("marks interrupted voice sends unknown on restart and never replays caller-cleaned media", async () => {
    const { inner, bridge, outcomes } = make();
    writeRecord({
      id: "33333333-3333-4333-8333-333333333333",
      kind: "voice",
      platform: "telegram",
      channelId: "123",
      text: "voice reply",
      attempts: 1,
      state: "sending",
      workIds: ["voice-work"],
      voiceFileName: "reply.ogg",
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:01.000Z",
    });

    await bridge.start();

    expect(inner.voiceSent).toEqual([]);
    expect(records()).toMatchObject([{ kind: "voice", state: "unknown", lastError: "interrupted_send" }]);
    expect(outcomes).toEqual([{ workIds: ["voice-work"], state: "unknown", error: "interrupted_send" }]);
    await bridge.stop();
  });

  it("does not retry voice not-sent failures because media cleanup belongs to the caller", async () => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-outbound-test-"));
    const inner = new FakeBridge();
    const wrapped = withDurableOutbound(inner, tmpDir, { drainIntervalMs: 30_000 });
    const audioPath = path.join(tmpDir, "reply.ogg");
    fs.writeFileSync(audioPath, "voice");
    inner.nextVoiceError = new DeliveryError("not connected", { outcome: "not_sent", retryable: true });

    await expect(wrapped.sendVoice!("123", audioPath, { workIds: ["voice-work"] } as TestSendOpts)).rejects.toMatchObject({
      outcome: "not_sent",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(inner.voiceSent).toHaveLength(1);
    expect(records()).toMatchObject([{ kind: "voice", state: "failed", lastError: "retryable_not_sent" }]);
    expect(fs.existsSync(audioPath)).toBe(true);
  });

  it("forwards voice only when the inner bridge supports it", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-outbound-test-"));
    const textOnly = withDurableOutbound(new TextOnlyBridge(), tmpDir);
    expect(textOnly.sendVoice).toBeUndefined();
  });
});
