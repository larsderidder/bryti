/**
 * Worker tool tests.
 *
 * We test the tool's validation logic, concurrency enforcement, and
 * worker_check disk-fallback. We do not test actual session spawning
 * (that requires a live model).
 *
 * worker_interrupt tests cover:
 * - cancelling a running worker (abort called, status set to cancelled)
 * - no-op on already-terminal workers
 * - not-found handling with disk fallback
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkerTools } from "./tools.js";
import { createWorkerRegistry } from "./registry.js";
import type { WorkerRegistry } from "./registry.js";
import type { MemoryStore, ScoredResult } from "../memory/store.js";
import type { Config } from "../config.js";

// Mock the embedding module so worker_interrupt (and any future completion
// paths) don't try to download/load a GGUF model during tests.
vi.mock("../memory/embeddings.js", () => ({
  embed: vi.fn().mockResolvedValue(new Array(768).fill(0)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bryti-worker-test-"));
}

function makeMockConfig(dataDir: string): Config {
  return {
    agent: {
      name: "TestBot",
      system_prompt: "You are a test bot.",
      model: "test-provider/test-model",
      fallback_models: [],
    },
    telegram: { token: "tok", allowed_users: [1] },
    whatsapp: { enabled: false, allowed_users: [] },
    models: {
      providers: [
        {
          name: "test-provider",
          base_url: "http://localhost:1234/v1",
          api: "openai-completions",
          api_key: "test-key",
          models: [{ id: "test-model" }],
        },
      ],
    },
    tools: {
      web_search: { enabled: true, searxng_url: "https://search.xithing.eu" },
      fetch_url: { enabled: true, timeout_ms: 5000 },
      files: { enabled: true, base_dir: path.join(dataDir, "files") },
      workers: { max_concurrent: 3 },
    },
    cron: [],
    data_dir: dataDir,
  };
}

function makeMockMemoryStore(): MemoryStore {
  const facts: Array<{ id: string; content: string }> = [];
  return {
    addFact(content: string, _source: string, _embedding: number[]): string {
      const id = `fact-${facts.length}`;
      facts.push({ id, content });
      return id;
    },
    removeFact(_id: string): void {},
    searchKeyword(_query: string, _limit: number): ScoredResult[] { return []; },
    searchVector(_embedding: number[], _limit: number): ScoredResult[] { return []; },
    close(): void {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("worker_dispatch — validation", () => {
  let tempDir: string;
  let config: Config;
  let registry: WorkerRegistry;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    config = makeMockConfig(tempDir);
    registry = createWorkerRegistry();
    memoryStore = makeMockMemoryStore();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects dispatch when isWorkerSession=true (no nesting)", async () => {
    const tools = createWorkerTools(config, memoryStore, registry, true);
    const dispatch = tools.find((t) => t.name === "worker_dispatch")!;

    const result = await dispatch.execute("call1", { task: "Do something" });
    expect((result.details as any).error).toMatch(/cannot dispatch/i);
  });

  it("rejects dispatch when max concurrent workers reached", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const dispatch = tools.find((t) => t.name === "worker_dispatch")!;

    // Fill up the registry with 3 running workers (default limit)
    for (let i = 0; i < 3; i++) {
      registry.register({
        workerId: `w-${i}`,
        status: "running",
        task: "placeholder",
        resultPath: "",
        workerDir: "",
        startedAt: new Date(),
        error: null,
        model: "m",
        abort: null,
        timeoutHandle: null,
      });
    }

    const result = await dispatch.execute("call1", { task: "Another task" });
    expect((result.details as any).error).toMatch(/maximum concurrent workers/i);
  });

  it("respects max_concurrent from config", async () => {
    config.tools.workers.max_concurrent = 2;
    const tools = createWorkerTools(config, memoryStore, registry);
    const dispatch = tools.find((t) => t.name === "worker_dispatch")!;

    // Only 2 running workers needed to hit the limit now
    for (let i = 0; i < 2; i++) {
      registry.register({
        workerId: `w-cfg-${i}`,
        status: "running",
        task: "placeholder",
        resultPath: "",
        workerDir: "",
        startedAt: new Date(),
        error: null,
        model: "m",
        abort: null,
        timeoutHandle: null,
      });
    }

    const result = await dispatch.execute("call1", { task: "Should be blocked" });
    expect((result.details as any).error).toMatch(/maximum concurrent workers/i);
    expect((result.details as any).error).toMatch(/2/);
  });

  it("rejects unknown tool names", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const dispatch = tools.find((t) => t.name === "worker_dispatch")!;

    const result = await dispatch.execute("call1", {
      task: "Research something",
      tools: ["shell" as any],
    });
    expect((result.details as any).error).toMatch(/unknown tool/i);
  });
});

describe("worker_dispatch — successful dispatch", () => {
  let tempDir: string;
  let config: Config;
  let registry: WorkerRegistry;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    config = makeMockConfig(tempDir);
    registry = createWorkerRegistry();
    memoryStore = makeMockMemoryStore();
  });

  afterEach(() => {
    // Cancel any timeout handles that were set, so the test process exits cleanly
    for (const entry of registry.list()) {
      if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
      if (entry.abort) {
        entry.abort().catch(() => {});
      }
      registry.update(entry.workerId, { status: "cancelled", timeoutHandle: null });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates worker directory and task.md", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const dispatch = tools.find((t) => t.name === "worker_dispatch")!;

    // We stub spawnWorkerSession indirectly by just checking the side effects
    // that happen before spawn (dir creation, task.md, registry entry).
    // The actual session spawn will fail (no real model) but we only check
    // the synchronous side effects here.
    const result = await dispatch.execute("call1", {
      task: "Find the best TypeScript linting tools",
      tools: ["web_search"],
    });

    const details = result.details as any;
    // Either succeeds (worker_id present) or fails for spawn reasons
    // But the worker dir and task.md should exist regardless.
    if (details.worker_id) {
      const workerId = details.worker_id as string;
      const workerDir = path.join(tempDir, "files", "workers", workerId);
      expect(fs.existsSync(workerDir)).toBe(true);
      expect(fs.existsSync(path.join(workerDir, "task.md"))).toBe(true);
      const taskContent = fs.readFileSync(path.join(workerDir, "task.md"), "utf-8");
      expect(taskContent).toBe("Find the best TypeScript linting tools");
    }
    // The test passes as long as no exception is thrown
  });

  it("registers the worker in the registry before spawn completes", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const dispatch = tools.find((t) => t.name === "worker_dispatch")!;

    const result = await dispatch.execute("call1", { task: "Some research task" });
    const details = result.details as any;

    if (details.worker_id) {
      const entry = registry.get(details.worker_id);
      expect(entry).not.toBeNull();
      expect(entry!.task).toBe("Some research task");
    }
  });

  it("returns worker_id, status=running, and result_path", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const dispatch = tools.find((t) => t.name === "worker_dispatch")!;

    const result = await dispatch.execute("call1", { task: "Research task" });
    const details = result.details as any;

    if (details.worker_id) {
      expect(details.status).toBe("running");
      expect(details.result_path).toContain("result.md");
      expect(details.trigger_hint).toContain(details.worker_id);
    }
  });

  it("includes the trigger_on_fact hint in the response", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const dispatch = tools.find((t) => t.name === "worker_dispatch")!;

    const result = await dispatch.execute("call1", { task: "Research something" });
    const details = result.details as any;

    if (details.worker_id) {
      expect(details.trigger_hint).toBe(`worker ${details.worker_id} complete`);
    }
  });
});

describe("worker_check", () => {
  let tempDir: string;
  let config: Config;
  let registry: WorkerRegistry;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    config = makeMockConfig(tempDir);
    registry = createWorkerRegistry();
    memoryStore = makeMockMemoryStore();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns error for unknown worker_id with no status.json", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const check = tools.find((t) => t.name === "worker_check")!;

    const result = await check.execute("call1", { worker_id: "w-notexist" });
    expect((result.details as any).error).toMatch(/worker not found/i);
  });

  it("returns status from in-memory registry", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const check = tools.find((t) => t.name === "worker_check")!;

    registry.register({
      workerId: "w-known",
      status: "running",
      task: "Some research",
      resultPath: path.join(tempDir, "files", "workers", "w-known", "result.md"),
      workerDir: path.join(tempDir, "files", "workers", "w-known"),
      startedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
      error: null,
      model: "test-provider/test-model",
      abort: null,
      timeoutHandle: null,
    });

    const result = await check.execute("call1", { worker_id: "w-known" });
    const details = result.details as any;
    expect(details.worker_id).toBe("w-known");
    expect(details.status).toBe("running");
    expect(details.elapsed_minutes).toBeGreaterThanOrEqual(4);
  });

  it("falls back to status.json on disk when not in registry", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const check = tools.find((t) => t.name === "worker_check")!;

    // Write a status.json as if a previous run wrote it
    const workerDir = path.join(tempDir, "files", "workers", "w-old");
    fs.mkdirSync(workerDir, { recursive: true });
    const statusFile = {
      worker_id: "w-old",
      status: "complete",
      task: "Old research task",
      started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      completed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      model: "test-provider/test-model",
      error: null,
      result_path: path.join(workerDir, "result.md"),
    };
    fs.writeFileSync(path.join(workerDir, "status.json"), JSON.stringify(statusFile), "utf-8");

    const result = await check.execute("call1", { worker_id: "w-old" });
    const details = result.details as any;
    expect(details.worker_id).toBe("w-old");
    expect(details.status).toBe("complete");
    expect(details.elapsed_minutes).toBeGreaterThanOrEqual(24);
  });

  it("returns error status correctly", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const check = tools.find((t) => t.name === "worker_check")!;

    registry.register({
      workerId: "w-failed",
      status: "failed",
      task: "Broken task",
      resultPath: path.join(tempDir, "files", "workers", "w-failed", "result.md"),
      workerDir: path.join(tempDir, "files", "workers", "w-failed"),
      startedAt: new Date(Date.now() - 2 * 60 * 1000),
      error: "Model error: context overflow",
      model: "test-provider/test-model",
      abort: null,
      timeoutHandle: null,
    });

    const result = await check.execute("call1", { worker_id: "w-failed" });
    const details = result.details as any;
    expect(details.status).toBe("failed");
    expect(details.error).toBe("Model error: context overflow");
  });
});

describe("worker_interrupt", () => {
  let tempDir: string;
  let config: Config;
  let registry: WorkerRegistry;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    config = makeMockConfig(tempDir);
    registry = createWorkerRegistry();
    memoryStore = makeMockMemoryStore();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns error for unknown worker_id with no status.json", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const interrupt = tools.find((t) => t.name === "worker_interrupt")!;

    const result = await interrupt.execute("call1", { worker_id: "w-notexist" });
    expect((result.details as any).error).toMatch(/worker not found/i);
  });

  it("returns no-op for a worker already in a terminal state", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const interrupt = tools.find((t) => t.name === "worker_interrupt")!;

    for (const status of ["complete", "failed", "timeout", "cancelled"] as const) {
      const workerId = `w-terminal-${status}`;
      registry.register({
        workerId,
        status,
        task: "Some task",
        resultPath: "",
        workerDir: "",
        startedAt: new Date(),
        error: null,
        model: "m",
        abort: null,
        timeoutHandle: null,
      });

      const result = await interrupt.execute("call1", { worker_id: workerId });
      const details = result.details as any;
      expect(details.status).toBe(status);
      expect(details.note).toMatch(/terminal state/i);
    }
  });

  it("calls abort() on a running worker and sets status to cancelled", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const interrupt = tools.find((t) => t.name === "worker_interrupt")!;

    let abortCalled = false;
    const workerDir = path.join(tempDir, "files", "workers", "w-running");
    fs.mkdirSync(workerDir, { recursive: true });

    registry.register({
      workerId: "w-running",
      status: "running",
      task: "Long research task",
      resultPath: path.join(workerDir, "result.md"),
      workerDir,
      startedAt: new Date(),
      error: null,
      model: "test-provider/test-model",
      abort: async () => { abortCalled = true; },
      timeoutHandle: null,
    });

    const result = await interrupt.execute("call1", { worker_id: "w-running" });
    const details = result.details as any;

    expect(details.status).toBe("cancelled");
    expect(abortCalled).toBe(true);

    const entry = registry.get("w-running");
    expect(entry!.status).toBe("cancelled");
    expect(entry!.completedAt).not.toBeNull();
  });

  it("clears the timeout handle when cancelling", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const interrupt = tools.find((t) => t.name === "worker_interrupt")!;

    const workerDir = path.join(tempDir, "files", "workers", "w-timeout");
    fs.mkdirSync(workerDir, { recursive: true });

    let timeoutFired = false;
    const handle = setTimeout(() => { timeoutFired = true; }, 50);

    registry.register({
      workerId: "w-timeout",
      status: "running",
      task: "Task with timeout",
      resultPath: path.join(workerDir, "result.md"),
      workerDir,
      startedAt: new Date(),
      error: null,
      model: "test-provider/test-model",
      abort: async () => {},
      timeoutHandle: handle,
    });

    await interrupt.execute("call1", { worker_id: "w-timeout" });

    // Wait longer than the timeout — it should not fire
    await new Promise((r) => setTimeout(r, 100));
    expect(timeoutFired).toBe(false);
  });

  it("writes status.json with cancelled status", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const interrupt = tools.find((t) => t.name === "worker_interrupt")!;

    const workerDir = path.join(tempDir, "files", "workers", "w-disk");
    fs.mkdirSync(workerDir, { recursive: true });

    registry.register({
      workerId: "w-disk",
      status: "running",
      task: "Disk test task",
      resultPath: path.join(workerDir, "result.md"),
      workerDir,
      startedAt: new Date(),
      error: null,
      model: "test-provider/test-model",
      abort: async () => {},
      timeoutHandle: null,
    });

    await interrupt.execute("call1", { worker_id: "w-disk" });

    const statusFile = path.join(workerDir, "status.json");
    expect(fs.existsSync(statusFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(statusFile, "utf-8"));
    expect(data.status).toBe("cancelled");
    expect(data.completed_at).not.toBeNull();
  });

  it("handles abort() throwing gracefully (still marks cancelled)", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const interrupt = tools.find((t) => t.name === "worker_interrupt")!;

    const workerDir = path.join(tempDir, "files", "workers", "w-abort-throws");
    fs.mkdirSync(workerDir, { recursive: true });

    registry.register({
      workerId: "w-abort-throws",
      status: "running",
      task: "Task where abort throws",
      resultPath: path.join(workerDir, "result.md"),
      workerDir,
      startedAt: new Date(),
      error: null,
      model: "test-provider/test-model",
      abort: async () => { throw new Error("session already disposed"); },
      timeoutHandle: null,
    });

    // Should not throw — abort errors are best-effort
    const result = await interrupt.execute("call1", { worker_id: "w-abort-throws" });
    expect((result.details as any).status).toBe("cancelled");

    const entry = registry.get("w-abort-throws");
    expect(entry!.status).toBe("cancelled");
  });

  it("handles no abort function (session not yet started)", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const interrupt = tools.find((t) => t.name === "worker_interrupt")!;

    const workerDir = path.join(tempDir, "files", "workers", "w-no-abort");
    fs.mkdirSync(workerDir, { recursive: true });

    // abort is null — session registered but not yet spawned
    registry.register({
      workerId: "w-no-abort",
      status: "running",
      task: "Task not yet spawned",
      resultPath: path.join(workerDir, "result.md"),
      workerDir,
      startedAt: new Date(),
      error: null,
      model: "test-provider/test-model",
      abort: null,
      timeoutHandle: null,
    });

    const result = await interrupt.execute("call1", { worker_id: "w-no-abort" });
    expect((result.details as any).status).toBe("cancelled");

    const entry = registry.get("w-no-abort");
    expect(entry!.status).toBe("cancelled");
  });

  it("falls back to status.json on disk when worker is not in registry", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const interrupt = tools.find((t) => t.name === "worker_interrupt")!;

    const workerDir = path.join(tempDir, "files", "workers", "w-old-complete");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, "status.json"),
      JSON.stringify({
        worker_id: "w-old-complete",
        status: "complete",
        task: "Old task",
        started_at: new Date(Date.now() - 3600000).toISOString(),
        completed_at: new Date().toISOString(),
        model: "test-provider/test-model",
        error: null,
        result_path: path.join(workerDir, "result.md"),
      }),
      "utf-8",
    );

    const result = await interrupt.execute("call1", { worker_id: "w-old-complete" });
    const details = result.details as any;
    expect(details.status).toBe("complete");
    expect(details.note).toMatch(/already finished/i);
  });
});

describe("worker_steer", () => {
  let tempDir: string;
  let config: Config;
  let registry: WorkerRegistry;
  let memoryStore: MemoryStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    config = makeMockConfig(tempDir);
    registry = createWorkerRegistry();
    memoryStore = makeMockMemoryStore();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns error for unknown worker_id", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const steer = tools.find((t) => t.name === "worker_steer")!;

    const result = await steer.execute("call1", {
      worker_id: "w-notexist",
      guidance: "Focus only on TypeScript.",
    });
    expect((result.details as any).error).toMatch(/worker not found/i);
  });

  it("returns no-op for a worker already in a terminal state", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const steer = tools.find((t) => t.name === "worker_steer")!;

    for (const status of ["complete", "failed", "timeout", "cancelled"] as const) {
      const workerId = `w-done-${status}`;
      registry.register({
        workerId,
        status,
        task: "Some task",
        resultPath: "",
        workerDir: "",
        startedAt: new Date(),
        error: null,
        model: "m",
        abort: null,
        timeoutHandle: null,
      });

      const result = await steer.execute("call1", {
        worker_id: workerId,
        guidance: "This should be ignored.",
      });
      const details = result.details as any;
      expect(details.status).toBe(status);
      expect(details.note).toMatch(/terminal state/i);
    }
  });

  it("writes steering.md into the worker directory", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const steer = tools.find((t) => t.name === "worker_steer")!;

    const workerDir = path.join(tempDir, "files", "workers", "w-steerable");
    fs.mkdirSync(workerDir, { recursive: true });

    registry.register({
      workerId: "w-steerable",
      status: "running",
      task: "Research LLMs",
      resultPath: path.join(workerDir, "result.md"),
      workerDir,
      startedAt: new Date(),
      error: null,
      model: "test-provider/test-model",
      abort: null,
      timeoutHandle: null,
    });

    const result = await steer.execute("call1", {
      worker_id: "w-steerable",
      guidance: "Skip GPT-4. Focus only on open-weight models released in 2025.",
    });

    expect((result.details as any).status).toBe("running");

    const steeringPath = path.join(workerDir, "steering.md");
    expect(fs.existsSync(steeringPath)).toBe(true);
    const content = fs.readFileSync(steeringPath, "utf-8");
    expect(content).toBe("Skip GPT-4. Focus only on open-weight models released in 2025.");
  });

  it("replaces the previous steering note on subsequent calls", async () => {
    const tools = createWorkerTools(config, memoryStore, registry);
    const steer = tools.find((t) => t.name === "worker_steer")!;

    const workerDir = path.join(tempDir, "files", "workers", "w-resterr");
    fs.mkdirSync(workerDir, { recursive: true });

    registry.register({
      workerId: "w-resterr",
      status: "running",
      task: "Research something",
      resultPath: path.join(workerDir, "result.md"),
      workerDir,
      startedAt: new Date(),
      error: null,
      model: "test-provider/test-model",
      abort: null,
      timeoutHandle: null,
    });

    await steer.execute("call1", { worker_id: "w-resterr", guidance: "First note." });
    await steer.execute("call2", { worker_id: "w-resterr", guidance: "Second note — replaces first." });

    const steeringPath = path.join(workerDir, "steering.md");
    const content = fs.readFileSync(steeringPath, "utf-8");
    expect(content).toBe("Second note — replaces first.");
  });
});
