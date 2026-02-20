import { describe, it, expect } from "vitest";
import { createWorkerRegistry } from "./registry.js";

describe("WorkerRegistry", () => {
  it("registers a worker and retrieves it by id", () => {
    const registry = createWorkerRegistry();
    const entry = registry.register({
      workerId: "w-abc123",
      status: "running",
      task: "Research something",
      resultPath: "/tmp/workers/w-abc123/result.md",
      workerDir: "/tmp/workers/w-abc123",
      startedAt: new Date(),
      error: null,
      model: "provider/model-id",
      abort: null,
      timeoutHandle: null,
    });

    expect(entry.workerId).toBe("w-abc123");
    expect(entry.status).toBe("running");
    expect(entry.completedAt).toBeNull();

    const retrieved = registry.get("w-abc123");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.workerId).toBe("w-abc123");
  });

  it("returns null for unknown worker ids", () => {
    const registry = createWorkerRegistry();
    expect(registry.get("no-such-id")).toBeNull();
  });

  it("counts running workers", () => {
    const registry = createWorkerRegistry();
    registry.register({ workerId: "w-1", status: "running", task: "A", resultPath: "", workerDir: "", startedAt: new Date(), error: null, model: "m", abort: null, timeoutHandle: null });
    registry.register({ workerId: "w-2", status: "running", task: "B", resultPath: "", workerDir: "", startedAt: new Date(), error: null, model: "m", abort: null, timeoutHandle: null });
    registry.register({ workerId: "w-3", status: "complete", task: "C", resultPath: "", workerDir: "", startedAt: new Date(), error: null, model: "m", abort: null, timeoutHandle: null });

    expect(registry.runningCount()).toBe(2);
  });

  it("updates worker fields", () => {
    const registry = createWorkerRegistry();
    registry.register({ workerId: "w-1", status: "running", task: "Task", resultPath: "", workerDir: "", startedAt: new Date(), error: null, model: "m", abort: null, timeoutHandle: null });

    const completed = new Date();
    registry.update("w-1", { status: "complete", completedAt: completed, error: null });

    const entry = registry.get("w-1");
    expect(entry!.status).toBe("complete");
    expect(entry!.completedAt).toBe(completed);
  });

  it("update is a no-op for unknown worker ids", () => {
    const registry = createWorkerRegistry();
    // Should not throw
    registry.update("no-such-id", { status: "failed" });
  });

  it("removes a worker from the registry", () => {
    const registry = createWorkerRegistry();
    registry.register({ workerId: "w-1", status: "running", task: "T", resultPath: "", workerDir: "", startedAt: new Date(), error: null, model: "m", abort: null, timeoutHandle: null });

    registry.remove("w-1");
    expect(registry.get("w-1")).toBeNull();
    expect(registry.runningCount()).toBe(0);
  });

  it("lists all entries", () => {
    const registry = createWorkerRegistry();
    registry.register({ workerId: "w-1", status: "running", task: "A", resultPath: "", workerDir: "", startedAt: new Date(), error: null, model: "m", abort: null, timeoutHandle: null });
    registry.register({ workerId: "w-2", status: "complete", task: "B", resultPath: "", workerDir: "", startedAt: new Date(), error: null, model: "m", abort: null, timeoutHandle: null });

    const all = registry.list();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.workerId).sort()).toEqual(["w-1", "w-2"]);
  });
});
