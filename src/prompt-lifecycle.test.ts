import { describe, it, expect, vi, afterEach } from "vitest";
import { runPromptWithActivityWatchdog } from "./prompt-lifecycle.js";

describe("runPromptWithActivityWatchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cleans up the inactivity timer and listener when the prompt rejects", async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const abort = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = vi.fn(() => {
      listeners.clear();
    });

    await expect(runPromptWithActivityWatchdog({
      sessionKey: "u1",
      timeoutMs: 1000,
      subscribe(listener) {
        listeners.add(listener);
        return unsubscribe;
      },
      abort,
      operation: async () => {
        throw new Error("provider failed");
      },
    })).rejects.toThrow("provider failed");

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts once after a full inactive interval", async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const abort = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = vi.fn(() => {
      listeners.clear();
    });

    const resultPromise = runPromptWithActivityWatchdog({
      sessionKey: "u1",
      timeoutMs: 1000,
      subscribe(listener) {
        listeners.add(listener);
        return unsubscribe;
      },
      abort,
      operation: async () => new Promise(() => {}),
    });

    await vi.advanceTimersByTimeAsync(1000);
    await expect(resultPromise).resolves.toMatchObject({ status: "timeout", reason: "inactivity" });
    expect(abort).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();

    for (const listener of listeners) {
      listener();
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("re-arms the inactivity timer on prompt activity", async () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const abort = vi.fn().mockResolvedValue(undefined);

    const resultPromise = runPromptWithActivityWatchdog({
      sessionKey: "u1",
      timeoutMs: 1000,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.clear();
      },
      abort,
      operation: async () => new Promise(() => {}),
    });

    await vi.advanceTimersByTimeAsync(700);
    for (const listener of listeners) {
      listener();
    }
    await vi.advanceTimersByTimeAsync(700);
    expect(abort).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    await expect(resultPromise).resolves.toMatchObject({ status: "timeout", reason: "inactivity" });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("allows a silent bounded bash call to outlast model inactivity", async () => {
    vi.useFakeTimers();
    let activity: (event?: { type: string; toolCallId?: string; toolName?: string; args?: unknown }) => void = () => {};
    let complete!: () => void;
    const abort = vi.fn().mockResolvedValue(undefined);
    const result = runPromptWithActivityWatchdog({
      sessionKey: "u1",
      timeoutMs: 1000,
      subscribe(listener) { activity = listener; return () => {}; },
      abort,
      operation: () => new Promise<void>((resolve) => { complete = resolve; }),
    });
    activity({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { timeout: 10 } });
    await vi.advanceTimersByTimeAsync(6000);
    expect(abort).not.toHaveBeenCalled();
    activity({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash" });
    complete();
    await expect(result).resolves.toEqual({ status: "completed", value: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the tool deadline even while activity continues", async () => {
    vi.useFakeTimers();
    let activity: (event?: { type: string; toolCallId?: string; toolName?: string; args?: unknown }) => void = () => {};
    const onTimeout = vi.fn();
    const result = runPromptWithActivityWatchdog({
      sessionKey: "u1", timeoutMs: 1000, toolGraceMs: 100,
      subscribe(listener) { activity = listener; return () => {}; },
      abort: vi.fn().mockResolvedValue(undefined),
      operation: () => new Promise(() => {}),
      onTimeout,
    });
    activity({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { timeout: 2 } });
    await vi.advanceTimersByTimeAsync(1500);
    activity({ type: "tool_execution_update", toolCallId: "bash-1", toolName: "bash" });
    await vi.advanceTimersByTimeAsync(600);
    await expect(result).resolves.toMatchObject({ status: "timeout", reason: "tool_deadline", toolName: "bash" });
    expect(onTimeout).toHaveBeenCalledWith("u1", expect.objectContaining({ reason: "tool_deadline", toolName: "bash" }));
  });

  it("bounds the entire prompt even with continuous activity", async () => {
    vi.useFakeTimers();
    let activity: () => void = () => {};
    const result = runPromptWithActivityWatchdog({
      sessionKey: "u1", timeoutMs: 1000, maxDurationMs: 2500,
      subscribe(listener) { activity = listener; return () => {}; },
      abort: vi.fn().mockResolvedValue(undefined),
      operation: () => new Promise(() => {}),
    });
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(800);
      activity();
    }
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toMatchObject({ status: "timeout", reason: "prompt_deadline" });
  });

  it("returns to the inactivity deadline after a tool finishes", async () => {
    vi.useFakeTimers();
    let activity: (event?: { type: string; toolCallId?: string; toolName?: string; args?: unknown }) => void = () => {};
    const abort = vi.fn().mockResolvedValue(undefined);
    const result = runPromptWithActivityWatchdog({
      sessionKey: "u1", timeoutMs: 1000,
      subscribe(listener) { activity = listener; return () => {}; }, abort,
      operation: () => new Promise(() => {}),
    });
    activity({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { timeout: 10 } });
    await vi.advanceTimersByTimeAsync(2000);
    activity({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash" });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ status: "timeout", reason: "inactivity" });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("does not let another tool or duplicate start extend the first tool's deadline", async () => {
    vi.useFakeTimers();
    let activity: (event?: { type: string; toolCallId?: string; toolName?: string; args?: unknown }) => void = () => {};
    const result = runPromptWithActivityWatchdog({
      sessionKey: "u1", timeoutMs: 1000, toolGraceMs: 0,
      subscribe(listener) { activity = listener; return () => {}; },
      abort: vi.fn().mockResolvedValue(undefined), operation: () => new Promise(() => {}),
    });
    activity({ type: "tool_execution_start", toolCallId: "first", toolName: "bash", args: { timeout: 2 } });
    await vi.advanceTimersByTimeAsync(1500);
    activity({ type: "tool_execution_start", toolCallId: "first", toolName: "bash", args: { timeout: 100 } });
    activity({ type: "tool_execution_start", toolCallId: "second", toolName: "bash", args: { timeout: 100 } });
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toMatchObject({ status: "timeout", reason: "tool_deadline" });
  });

  it.each([undefined, 0, -1, NaN, Infinity, "600"])("does not extend tool execution for an invalid timeout: %s", async (timeout) => {
    vi.useFakeTimers();
    let activity: (event?: { type: string; toolCallId?: string; toolName?: string; args?: unknown }) => void = () => {};
    const result = runPromptWithActivityWatchdog({
      sessionKey: "u1", timeoutMs: 1000,
      subscribe(listener) { activity = listener; return () => {}; },
      abort: vi.fn().mockResolvedValue(undefined), operation: () => new Promise(() => {}),
    });
    activity({ type: "tool_execution_start", toolCallId: "first", toolName: "bash", args: { timeout } });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ status: "timeout", reason: "tool_deadline" });
  });
});
