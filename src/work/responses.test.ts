import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ChannelBridge } from "../channels/types.js";
import { DurableOutboundBridge } from "../channels/outbound-queue.js";
import { deliveryUnknown, deliveryNotSent } from "../channels/delivery.js";
import { recoverCompletedResponses, type AppState } from "../process-message.js";
import { createWorkStore, type WorkStore } from "./store.js";

vi.mock("../agent.js", async (importActual) => ({
  ...await importActual<typeof import("../agent.js")>(), loadUserSession: vi.fn(), promptWithFallback: vi.fn(),
}));

describe("completed response recovery", () => {
  let dir: string;
  let work: WorkStore;
  let message: IncomingMessage;
  let inner: ChannelBridge;
  let outbound: DurableOutboundBridge;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-response-stage-"));
    work = createWorkStore(dir);
    message = work.accept({ userId: "u", platform: "telegram", channelId: "chat", channelThreadId: "topic", text: "request", raw: null }).record.message;
    work.claim(message.workIds!);
    inner = { name: "test", platform: "telegram", start: vi.fn(), stop: vi.fn(), onMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue("sent-id"), sendVoice: vi.fn().mockResolvedValue("voice-id"),
      sendTyping: vi.fn(), editMessage: vi.fn(), sendApprovalRequest: vi.fn() };
    outbound = new DurableOutboundBridge(inner, dir, { onOutcome: (event) => work.recordResponse(event.workIds, event.state, event.error) });
  });

  afterEach(async () => {
    await outbound.stop();
    work.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function state(): AppState {
    return { config: { data_dir: dir }, workStore: work, bridges: [outbound] } as AppState;
  }

  it("recovers the exact answer after staging but before delivery without a model turn", async () => {
    const staged = work.stageResponse(message, "The completed answer", {}, { sessionFile: "/private/session.jsonl", entryIds: ["assistant-entry"] });
    work.close();
    work = createWorkStore(dir);
    expect(work.recover().interrupted).toEqual([]);
    expect(work.pendingResponses()[0].source?.entryIds).toEqual(["assistant-entry"]);
    await recoverCompletedResponses(state(), () => true);
    expect(inner.sendMessage).toHaveBeenCalledWith("chat", "The completed answer", { channelThreadId: "topic" });
    expect(work.get(message.workId!)?.execution).toBe("completed");
    expect(work.pendingResponses()).toEqual([]);
    await outbound.sendMessage("chat", "The completed answer", { ...staged.opts, responseId: staged.id });
    expect(inner.sendMessage).toHaveBeenCalledOnce();
  });

  it("retains one stable response identity across repeated staging", () => {
    const first = work.stageResponse(message, "answer");
    expect(work.stageResponse(message, "answer").id).toBe(first.id);
    expect(() => work.stageResponse(message, "different answer")).toThrow("different content");
  });

  it("does not transfer a completed response to another destination", () => {
    work.stageResponse(message, "answer");
    expect(() => work.stageResponse({ ...message, channelId: "another-chat" }, "answer")).toThrow("owning work");
  });

  it("rejects malformed response identities before any outbound file or send", async () => {
    await expect(outbound.sendMessage("chat", "answer", { responseId: "../../other" })).rejects.toMatchObject({ outcome: "not_sent" });
    expect(inner.sendMessage).not.toHaveBeenCalled();
  });

  it("never repeats ambiguous delivery when the same staged answer is recovered", async () => {
    const staged = work.stageResponse(message, "answer");
    vi.mocked(inner.sendMessage).mockRejectedValue(deliveryUnknown("connection lost after send"));
    await expect(outbound.sendMessage("chat", "answer", { ...staged.opts, responseId: staged.id })).rejects.toMatchObject({ outcome: "unknown" });
    await outbound.stop();
    work.recordResponse(message.workIds!, "pending");
    await recoverCompletedResponses(state(), () => true);
    expect(inner.sendMessage).toHaveBeenCalledOnce();
    expect(work.get(message.workId!)?.delivery).toBe("unknown");
  });

  it("hands pending retries back to the same outbound record instead of creating another", async () => {
    const staged = work.stageResponse(message, "answer");
    vi.mocked(inner.sendMessage).mockRejectedValue(deliveryNotSent("temporary rejection", { retryable: true }));
    await expect(outbound.sendMessage("chat", "answer", { ...staged.opts, responseId: staged.id })).rejects.toMatchObject({ outcome: "not_sent" });
    await recoverCompletedResponses(state(), () => true);
    expect(inner.sendMessage).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.join(dir, "pending", "outbound", "telegram"))).toEqual([`${staged.id}.json`]);
  });

  it("does not deliver to a destination whose authorization was revoked", async () => {
    work.stageResponse(message, "answer");
    await recoverCompletedResponses(state(), () => false);
    expect(inner.sendMessage).not.toHaveBeenCalled();
    expect(work.get(message.workId!)?.delivery).toBe("failed");
  });

  it("rechecks authorization when startup drains a retained outbound record", async () => {
    vi.useFakeTimers();
    const staged = work.stageResponse(message, "answer");
    vi.mocked(inner.sendMessage).mockRejectedValue(deliveryNotSent("temporary rejection", { retryable: true }));
    await expect(outbound.sendMessage("chat", "answer", { ...staged.opts, responseId: staged.id })).rejects.toMatchObject({ outcome: "not_sent" });
    await outbound.stop();
    vi.mocked(inner.sendMessage).mockClear();
    const canDeliver = vi.fn().mockReturnValue(false);
    outbound = new DurableOutboundBridge(inner, dir, { canDeliver, drainIntervalMs: 0,
      onOutcome: (event) => work.recordResponse(event.workIds, event.state, event.error) });
    vi.advanceTimersByTime(10_000);
    await outbound.start();
    expect(canDeliver).toHaveBeenCalledWith({ platform: "telegram", channelId: "chat", channelThreadId: "topic", workIds: message.workIds });
    expect(inner.sendMessage).not.toHaveBeenCalled();
    expect(work.get(message.workId!)?.delivery).toBe("failed");
  });

  it("does not send a text duplicate after interrupted voice delivery", async () => {
    const staged = work.stageResponse(message, "answer");
    vi.mocked(inner.sendVoice!).mockRejectedValue(deliveryUnknown("voice dispatch interrupted"));
    await expect(outbound.sendVoice!("chat", "/caller/audio.ogg", { ...staged.opts, responseId: staged.id })).rejects.toMatchObject({ outcome: "unknown" });
    await outbound.stop();
    work.recordResponse(message.workIds!, "pending");
    await recoverCompletedResponses(state(), () => true);
    expect(inner.sendMessage).not.toHaveBeenCalled();
    expect(inner.sendVoice).toHaveBeenCalledOnce();
  });

  it("recovers committed text when its voice was definitely rejected before sending", async () => {
    const staged = work.stageResponse(message, "answer");
    vi.mocked(inner.sendVoice!).mockRejectedValue(deliveryNotSent("voice unsupported", { retryable: false }));
    await expect(outbound.sendVoice!("chat", "/caller/audio.ogg", { ...staged.opts, responseId: staged.id })).rejects.toMatchObject({ outcome: "not_sent" });
    await outbound.stop();
    expect(work.pendingResponses()).toHaveLength(1);
    await recoverCompletedResponses(state(), () => true);
    expect(inner.sendMessage).toHaveBeenCalledOnce();
    expect(work.get(message.workId!)?.delivery).toBe("delivered");
  });
});
