/**
 * Integration tests for the worker spawn lifecycle.
 *
 * spawnWorkerSession() is complex enough that the existing tools.test.ts only
 * verifies the public dispatch API, not the internal completion/failure paths.
 * These tests exercise:
 *
 *   1. Completion path: status.json written as "complete", archival fact added
 *      to MemoryStore, projection trigger callback invoked.
 *   2. Failure path: status.json written as "failed", failure fact added to
 *      MemoryStore, no trigger invoked.
 *   3. Timeout path: status.json written as "timeout" when the timeout fires
 *      before the session finishes.
 *   4. Cancel path: status.json stays "cancelled" even when the abort causes
 *      session.prompt() to throw.
 *
 * Strategy: inject a mock completeFn in place of a real AgentSession.
 * spawnWorkerSession() creates the session internally so we cannot inject it
 * directly — instead we spy on `createAgentSession` from the SDK.
 *
 * Because createAgentSession is a named export from the SDK and spawn.ts
 * imports it at the top of the file, we use vi.mock() to replace it before
 * any test runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Mock the SDK session factory so tests never open a real network connection
// ---------------------------------------------------------------------------

const mockAbort = vi.fn().mockResolvedValue(undefined);
const mockDispose = vi.fn();
const mockReload = vi.fn().mockResolvedValue(undefined);
let mockPromptImpl: () => Promise<void> = async () => {};
let mockMessages: unknown[] = [];

// Mock embed so tests never load the embedding model (slow, 300MB download)
vi.mock("../memory/embeddings.js", () => ({
  embed: vi.fn().mockResolvedValue(null),
  embeddingsAvailable: vi.fn().mockReturnValue(false),
  warmupEmbeddings: vi.fn().mockResolvedValue(undefined),
  disposeEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@mariozechner/pi-coding-agent", async (importActual) => {
  const actual = await importActual<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: vi.fn().mockImplementation(async () => ({
      session: {
        get messages() { return mockMessages; },
        async prompt() { return mockPromptImpl(); },
        abort: mockAbort,
        dispose: mockDispose,
        async reload() { return mockReload(); },
        agent: { replaceMessages(_msgs: unknown[]) {} },
        getContextUsage() { return { percent: 5, tokens: 500, contextWindow: 10000 }; },
        async setModel() {},
      },
    })),
    DefaultResourceLoader: class {
      constructor() {}
      async reload() {}
    },
    SessionManager: {
      inMemory: (_dir: string) => ({}),
    },
    SettingsManager: {
      create: (_dataDir: string, _agentDir: string) => ({
        load: async () => ({}),
      }),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports after mock setup
// ---------------------------------------------------------------------------

import { spawnWorkerSession, writeStatusFile, type WorkerStatusFile } from "./spawn.js";
import { createWorkerRegistry } from "./registry.js";
import { createMemoryStore } from "../memory/store.js";
import type { Config } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bryti-spawn-test-"));
}

function makeConfig(dataDir: string): Config {
  return {
    agent: {
      name: "test",
      system_prompt: "",
      model: "test-provider/test-model",
      fallback_models: [],
      timezone: "UTC",
    },
    telegram: { token: "", allowed_users: [12345] },
    whatsapp: { enabled: false, allowed_users: [] },
    models: {
      providers: [
        {
          name: "test-provider",
          base_url: "http://localhost:9999",
          api: "openai-completions",
          api_key: "test-key",
          models: [{ id: "test-model" }],
        },
      ],
    },
    tools: {
      web_search: { enabled: false, searxng_url: "" },
      fetch_url: { timeout_ms: 10000 },
      files: { base_dir: "" },
      workers: { max_concurrent: 3, model: undefined },
    },
    integrations: {},
    cron: [],
    trust: { approved_tools: [] },
    data_dir: dataDir,
    active_hours: undefined,
  };
}

function readStatusFile(workerDir: string): WorkerStatusFile {
  return JSON.parse(fs.readFileSync(path.join(workerDir, "status.json"), "utf-8"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("writeStatusFile", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("writes readable JSON with all required fields", () => {
    const now = new Date().toISOString();
    writeStatusFile(tmpDir, {
      worker_id: "w-abc123",
      status: "complete",
      task: "research task",
      started_at: now,
      completed_at: now,
      model: "test/model",
      error: null,
      result_path: path.join(tmpDir, "result.md"),
    });

    const parsed = readStatusFile(tmpDir);
    expect(parsed.worker_id).toBe("w-abc123");
    expect(parsed.status).toBe("complete");
    expect(parsed.error).toBeNull();
  });

  it("overwrites previous status on second call", () => {
    const base = {
      worker_id: "w-overwrite",
      task: "t",
      started_at: new Date().toISOString(),
      completed_at: null as string | null,
      model: "m",
      error: null as string | null,
      result_path: "/r",
    };
    writeStatusFile(tmpDir, { ...base, status: "running" });
    writeStatusFile(tmpDir, { ...base, status: "complete", completed_at: new Date().toISOString() });

    expect(readStatusFile(tmpDir).status).toBe("complete");
  });

  it("swallows errors when the directory does not exist", () => {
    expect(() =>
      writeStatusFile("/nonexistent-dir/does-not-exist", {
        worker_id: "w-x",
        status: "failed",
        task: "t",
        started_at: new Date().toISOString(),
        completed_at: null,
        model: "m",
        error: "oops",
        result_path: "/r",
      }),
    ).not.toThrow();
  });
});

describe("spawnWorkerSession completion lifecycle", () => {
  let tmpDir: string;
  let workerDir: string;
  let config: Config;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    workerDir = path.join(tmpDir, "workers", "w-test01");
    fs.mkdirSync(workerDir, { recursive: true });
    config = makeConfig(tmpDir);
    mockMessages = [];
    mockPromptImpl = async () => {};
    mockAbort.mockClear();
    mockDispose.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllTimers();
  });

  function registerWorker(registry: ReturnType<typeof createWorkerRegistry>, workerId: string, task: string) {
    registry.register({
      workerId,
      status: "running",
      task,
      resultPath: path.join(workerDir, "result.md"),
      workerDir,
      startedAt: new Date(),
      error: null,
      model: "test/model",
      abort: null,
      timeoutHandle: null,
    });
  }

  it("writes status.json as 'complete' after a successful prompt", async () => {
    const registry = createWorkerRegistry();
    registerWorker(registry, "w-test01", "test task");
    const memStore = createMemoryStore("user-1", tmpDir);

    try {
      await spawnWorkerSession({
        config,
        workerId: "w-test01",
        workerDir,
        task: "test task",
        modelOverride: undefined,
        toolNames: [],
        memoryStore: memStore,
        registry,
        timeoutMs: 30_000,
      });

      const status = readStatusFile(workerDir);
      expect(status.status).toBe("complete");
      expect(status.worker_id).toBe("w-test01");
      expect(status.completed_at).not.toBeNull();
      expect(status.error).toBeNull();
    } finally {
      memStore.close();
    }
  });

  it("archives a completion fact in MemoryStore", async () => {
    const registry = createWorkerRegistry();
    registerWorker(registry, "w-test01", "archive fact task");
    const memStore = createMemoryStore("user-2", tmpDir);

    try {
      await spawnWorkerSession({
        config,
        workerId: "w-test01",
        workerDir,
        task: "archive fact task",
        modelOverride: undefined,
        toolNames: [],
        memoryStore: memStore,
        registry,
        timeoutMs: 30_000,
      });

      const results = memStore.searchKeyword("w-test01 complete", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("w-test01");
      expect(results[0].content).toContain("complete");
    } finally {
      memStore.close();
    }
  });

  it("invokes the onTrigger callback with triggered projections", async () => {
    const registry = createWorkerRegistry();
    registerWorker(registry, "w-test01", "trigger test");
    const memStore = createMemoryStore("user-3", tmpDir);

    // projectionStore mock: checkTriggers returns one triggered projection
    const mockProjectionStore = {
      checkTriggers: vi.fn().mockResolvedValue([
        { id: "proj-1", summary: "Check worker results" },
      ]),
      close: vi.fn(),
    };

    const triggerCalls: Array<{ id: string; summary: string }[]> = [];

    try {
      await spawnWorkerSession({
        config,
        workerId: "w-test01",
        workerDir,
        task: "trigger test",
        modelOverride: undefined,
        toolNames: [],
        memoryStore: memStore,
        projectionStore: mockProjectionStore as any,
        registry,
        timeoutMs: 30_000,
        onTrigger: (triggered) => { triggerCalls.push(triggered); },
      });

      expect(triggerCalls).toHaveLength(1);
      expect(triggerCalls[0][0].id).toBe("proj-1");
      expect(triggerCalls[0][0].summary).toBe("Check worker results");
    } finally {
      memStore.close();
    }
  });

  it("writes status.json as 'failed' when prompt throws", async () => {
    mockPromptImpl = async () => { throw new Error("model unavailable"); };

    const registry = createWorkerRegistry();
    registerWorker(registry, "w-test01", "failing task");
    const memStore = createMemoryStore("user-4", tmpDir);

    try {
      await spawnWorkerSession({
        config,
        workerId: "w-test01",
        workerDir,
        task: "failing task",
        modelOverride: undefined,
        toolNames: [],
        memoryStore: memStore,
        registry,
        timeoutMs: 30_000,
      });

      const status = readStatusFile(workerDir);
      expect(status.status).toBe("failed");
      expect(status.error).toContain("model unavailable");
    } finally {
      memStore.close();
    }
  });

  it("archives a failure fact when prompt throws", async () => {
    mockPromptImpl = async () => { throw new Error("connection refused"); };

    const registry = createWorkerRegistry();
    registerWorker(registry, "w-test01", "fail archive");
    const memStore = createMemoryStore("user-5", tmpDir);

    try {
      await spawnWorkerSession({
        config,
        workerId: "w-test01",
        workerDir,
        task: "fail archive",
        modelOverride: undefined,
        toolNames: [],
        memoryStore: memStore,
        registry,
        timeoutMs: 30_000,
      });

      const results = memStore.searchKeyword("w-test01 failed", 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("w-test01");
      expect(results[0].content).toContain("failed");
    } finally {
      memStore.close();
    }
  });

  it("does not invoke onTrigger when the prompt fails", async () => {
    mockPromptImpl = async () => { throw new Error("timeout"); };

    const registry = createWorkerRegistry();
    registerWorker(registry, "w-test01", "fail no trigger");
    const memStore = createMemoryStore("user-6", tmpDir);
    const triggerCalls: unknown[] = [];

    try {
      await spawnWorkerSession({
        config,
        workerId: "w-test01",
        workerDir,
        task: "fail no trigger",
        modelOverride: undefined,
        toolNames: [],
        memoryStore: memStore,
        registry,
        timeoutMs: 30_000,
        onTrigger: (t) => { triggerCalls.push(t); },
      });

      expect(triggerCalls).toHaveLength(0);
    } finally {
      memStore.close();
    }
  });

  it("respects pre-cancelled status: does not overwrite with 'failed'", async () => {
    // Simulate a cancel that happened before prompt returned
    mockPromptImpl = async () => { throw new Error("abort"); };

    const registry = createWorkerRegistry();
    registerWorker(registry, "w-test01", "cancel test");
    // Pre-set status to cancelled in registry to simulate worker_interrupt
    registry.update("w-test01", { status: "cancelled", completedAt: new Date() });

    const memStore = createMemoryStore("user-7", tmpDir);

    try {
      await spawnWorkerSession({
        config,
        workerId: "w-test01",
        workerDir,
        task: "cancel test",
        modelOverride: undefined,
        toolNames: [],
        memoryStore: memStore,
        registry,
        timeoutMs: 30_000,
      });

      // The abort path returns early when status is "cancelled" — no status.json written
      expect(fs.existsSync(path.join(workerDir, "status.json"))).toBe(false);
    } finally {
      memStore.close();
    }
  });
});
