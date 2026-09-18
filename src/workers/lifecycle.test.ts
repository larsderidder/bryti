import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerLifecycle } from "./lifecycle.js";
import { createWorkerRegistry } from "./registry.js";
import { collectWorkerEvents, registerWorkerOwner } from "./recovery.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("worker shutdown", () => {
  let dir: string;
  let registry: ReturnType<typeof createWorkerRegistry>;
  let lifecycle: WorkerLifecycle;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-worker-shutdown-"));
    registry = createWorkerRegistry();
    lifecycle = new WorkerLifecycle();
    lifecycle.register(registry);
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function worker(status: "running" | "queued" = "running") {
    const workerId = "w-12345678";
    const workerDir = path.join(dir, "files", "workers", workerId);
    fs.mkdirSync(workerDir, { recursive: true });
    registerWorkerOwner(dir, workerId, { userId: "u", channelId: "chat", platform: "telegram" });
    return registry.register({
      workerId, workerDir, status, task: "research", model: "test/model",
      resultPath: path.join(workerDir, "result.md"), startedAt: new Date(),
      error: null, abort: vi.fn().mockResolvedValue(undefined), timeoutHandle: null,
    });
  }

  it("waits for completion within the grace period without aborting", async () => {
    const entry = worker();
    const run = deferred();
    lifecycle.track(run.promise);
    const stop = lifecycle.stop(1000);
    expect(lifecycle.stopping).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    registry.update(entry.workerId, { status: "complete" });
    run.resolve();
    await stop;
    expect(entry.abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("persists interruption before abort and waits for the worker to settle", async () => {
    const entry = worker();
    const run = deferred();
    lifecycle.track(run.promise);
    entry.abort = vi.fn(async () => {
      const saved = JSON.parse(fs.readFileSync(path.join(entry.workerDir, "status.json"), "utf8"));
      expect(saved.status).toBe("interrupted");
      run.resolve();
    });
    const stop = lifecycle.stop(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await stop;
    expect(entry.status).toBe("interrupted");
    expect(entry.abort).toHaveBeenCalledOnce();
    expect(collectWorkerEvents(dir, true)[0].workId).toBe("worker:w-12345678:interrupted");
  });

  it("interrupts queued work without starting it", async () => {
    const entry = worker("queued");
    await lifecycle.stop(1000);
    expect(entry.status).toBe("interrupted");
    expect(entry.abort).not.toHaveBeenCalled();
    expect(registry.nextQueued()).toBeNull();
  });

  it("keeps cancellation terminal while awaiting an already aborted run", async () => {
    const entry = worker();
    registry.update(entry.workerId, { status: "cancelled" });
    const run = deferred();
    lifecycle.track(run.promise);
    const stop = lifecycle.stop(1000);
    run.resolve();
    await stop;
    expect(entry.status).toBe("cancelled");
    expect(entry.abort).not.toHaveBeenCalled();
  });

  it("shares shutdown between callers", async () => {
    const entry = worker();
    const run = deferred();
    entry.abort = vi.fn(async () => { run.resolve(); });
    lifecycle.track(run.promise);
    const first = lifecycle.stop(1000);
    const second = lifecycle.stop(1000);
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, second]);
    expect(entry.abort).toHaveBeenCalledOnce();
  });

  it("refuses an in-process restart if a worker ignores abort", async () => {
    worker();
    lifecycle.track(deferred().promise);
    const stop = lifecycle.stop(1000, 500);
    const rejected = expect(stop).rejects.toThrow("Workers did not stop");
    await vi.advanceTimersByTimeAsync(1500);
    await rejected;
  });
});
