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
    await expect(resultPromise).resolves.toEqual({ status: "timeout" });
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
    await expect(resultPromise).resolves.toEqual({ status: "timeout" });
    expect(abort).toHaveBeenCalledOnce();
  });
});
