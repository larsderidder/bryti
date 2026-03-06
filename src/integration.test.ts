/**
 * Integration tests for critical end-to-end paths.
 *
 * These tests exercise multiple modules together (with external I/O either
 * real SQLite or controlled via temporary directories) without requiring live
 * LLM calls or network access.
 *
 * Coverage areas:
 *   1. Reflection deduplication — running reflection twice with the same LLM
 *      output must not create duplicate projections.
 *   2. Reflection timestamp gate — when no new messages have arrived since the
 *      last run, the pass must skip without calling the LLM.
 *   3. Worker status-file lifecycle — writeStatusFile writes readable JSON;
 *      a second call overwrites rather than appending.
 *   4. Message queue image carry-through — images from all burst entries reach
 *      the merged message (regression test for the silent-drop bug).
 *   5. Memory store dedup — addFact() returns the existing ID on duplicate
 *      content and does not insert a second row.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bryti-int-test-"));
}

// ---------------------------------------------------------------------------
// 1. Reflection deduplication
// ---------------------------------------------------------------------------

import {
  runReflection,
  type sdkComplete,
  type ReflectionOutput,
} from "./projection/reflection.js";
import { createProjectionStore } from "./projection/index.js";
import type { Config } from "./config.js";

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
      workers: { max_concurrent: 3 },
    },
    integrations: {},
    cron: [],
    trust: { approved_tools: [] },
    data_dir: dataDir,
    active_hours: undefined,
  };
}

describe("Reflection deduplication", () => {
  let tmpDir: string;
  let config: Config;
  let historyDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    config = makeConfig(tmpDir);
    historyDir = path.join(tmpDir, "history");
    fs.mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeHistory(entries: Array<{ role: string; content: string; timestamp: string }>): void {
    const today = new Date().toISOString().slice(0, 10);
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(path.join(historyDir, `${today}.jsonl`), lines);
  }

  it("does not create duplicate projections when run twice with the same LLM output", async () => {
    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeHistory([
      { role: "user", content: "I have a dentist appointment on 2026-04-01", timestamp: recentTs },
      { role: "assistant", content: "Noted.", timestamp: recentTs },
    ]);

    const mockLlm: typeof sdkComplete = async () =>
      JSON.stringify({
        project: [
          { summary: "Dentist appointment", when: "2026-04-01", resolution: "day" },
        ],
        archive: [],
      } satisfies ReflectionOutput);

    const store = createProjectionStore("12345", tmpDir);
    try {
      // First run — should create the projection
      const first = await runReflection(config, "12345", 30, store, mockLlm);
      expect(first.projectionsAdded).toBe(1);

      // Advance last-reflection time by writing new history so the gate passes
      const newerTs = new Date(Date.now() - 1 * 60 * 1000).toISOString();
      writeHistory([
        { role: "user", content: "I have a dentist appointment on 2026-04-01", timestamp: newerTs },
        { role: "assistant", content: "Noted.", timestamp: newerTs },
      ]);

      // Second run with identical LLM output — projection already exists, count must not increase
      const second = await runReflection(config, "12345", 30, store, mockLlm);
      expect(second.projectionsAdded).toBe(0);

      // Only one projection in the store
      const all = store.getUpcoming(365);
      const dentist = all.filter((p) => p.summary === "Dentist appointment");
      expect(dentist).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("skips the LLM call when no new messages since last reflection timestamp", async () => {
    // Write history that is older than our faked last-reflection timestamp
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    writeHistory([
      { role: "user", content: "I want a reminder tomorrow", timestamp: oldTs },
    ]);

    // Fake last_reflection = 30 minutes ago (after the history entry)
    const Database = (await import("better-sqlite3")).default;
    const userDir = path.join(tmpDir, "users", "12345");
    fs.mkdirSync(userDir, { recursive: true });
    const db = new Database(path.join(userDir, "memory.db"));
    db.exec("CREATE TABLE IF NOT EXISTS reflection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO reflection_meta (key, value) VALUES (?, ?)").run(
      "last_reflection",
      new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    );
    db.close();

    let llmCalled = false;
    const mockLlm: typeof sdkComplete = async () => {
      llmCalled = true;
      return '{"project":[],"archive":[]}';
    };

    const store = createProjectionStore("12345", tmpDir);
    try {
      const result = await runReflection(config, "12345", 30, store, mockLlm);
      expect(result.skipped).toBe(true);
      expect(llmCalled).toBe(false);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Worker status-file lifecycle
// ---------------------------------------------------------------------------

import { writeStatusFile, type WorkerStatusFile } from "./workers/spawn.js";

describe("Worker writeStatusFile", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("writes a readable status.json", () => {
    const status: WorkerStatusFile = {
      worker_id: "w-001",
      status: "complete",
      task: "research task",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      model: "test/model",
      error: null,
      result_path: path.join(tmpDir, "result.md"),
    };

    writeStatusFile(tmpDir, status);

    const raw = fs.readFileSync(path.join(tmpDir, "status.json"), "utf-8");
    const parsed = JSON.parse(raw) as WorkerStatusFile;
    expect(parsed.worker_id).toBe("w-001");
    expect(parsed.status).toBe("complete");
    expect(parsed.error).toBeNull();
  });

  it("overwrites status.json on a second call", () => {
    const base = {
      worker_id: "w-002",
      task: "task",
      started_at: new Date().toISOString(),
      completed_at: null,
      model: "test/model",
      error: null,
      result_path: path.join(tmpDir, "result.md"),
    };

    writeStatusFile(tmpDir, { ...base, status: "running" });
    writeStatusFile(tmpDir, { ...base, status: "complete", completed_at: new Date().toISOString() });

    const raw = fs.readFileSync(path.join(tmpDir, "status.json"), "utf-8");
    const parsed = JSON.parse(raw) as WorkerStatusFile;
    expect(parsed.status).toBe("complete");
  });

  it("does not throw when the directory does not exist", () => {
    const nonexistent = path.join(tmpDir, "does-not-exist");
    // Should swallow the error (best-effort write)
    expect(() => writeStatusFile(nonexistent, {
      worker_id: "w-003",
      status: "failed",
      task: "t",
      started_at: new Date().toISOString(),
      completed_at: null,
      model: "m",
      error: "some error",
      result_path: "/nowhere",
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Message queue — image carry-through integration
// ---------------------------------------------------------------------------

import { MessageQueue } from "./message-queue.js";
import type { IncomingMessage } from "./channels/types.js";

describe("MessageQueue image carry-through", () => {
  it("carries images from all burst entries into the merged message", async () => {
    const results: IncomingMessage[] = [];
    const q = new MessageQueue(
      async (msg) => { results.push(msg); },
      async () => {},
      10,
      5000, // 5-second merge window — both enqueues land before drain fires
    );

    const base = { userId: "u1", channelId: "c1", platform: "telegram" as const, raw: null };

    // Enqueue both synchronously so they are both in the queue before drain processes them
    q.enqueue({ ...base, text: "", images: [{ data: "imgA", mimeType: "image/jpeg" }] });
    q.enqueue({ ...base, text: "here is the photo" });

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    // With a 5s merge window both messages should have merged into one
    if (results.length === 1) {
      expect(results[0].images).toBeDefined();
      expect(results[0].images!.length).toBeGreaterThanOrEqual(1);
      expect(results[0].images![0].data).toBe("imgA");
    } else {
      // Messages processed separately (race): verify image is preserved on the entry that had it
      const withImage = results.find((m) => m.images && m.images.length > 0);
      expect(withImage).toBeDefined();
    }
  });

  it("does not add an images field when no entry has images", async () => {
    const results: IncomingMessage[] = [];
    const q = new MessageQueue(
      async (msg) => { results.push(msg); },
      async () => {},
      10,
      5000,
    );

    const base = { userId: "u2", channelId: "c2", platform: "telegram" as const, raw: null };
    q.enqueue({ ...base, text: "hello" });
    q.enqueue({ ...base, text: "world" });

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const merged = results.find((m) => m.text.includes("hello") || m.text.includes("world"));
    expect(merged).toBeDefined();
    // images should be absent (undefined) when no entry had images
    if (results.length === 1) {
      expect(merged!.images).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Memory store — content-hash deduplication
// ---------------------------------------------------------------------------

import { createMemoryStore } from "./memory/store.js";

describe("MemoryStore deduplication", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns the existing ID when the same content is inserted twice", () => {
    const store = createMemoryStore("dedup-user", tmpDir);
    try {
      const id1 = store.addFact("cats are fluffy", "test", null);
      const id2 = store.addFact("cats are fluffy", "other-source", null);
      expect(id1).toBe(id2);
    } finally {
      store.close();
    }
  });

  it("gives distinct IDs to different content", () => {
    const store = createMemoryStore("dedup-user2", tmpDir);
    try {
      const id1 = store.addFact("cats are fluffy", "test", null);
      const id2 = store.addFact("dogs are loyal", "test", null);
      expect(id1).not.toBe(id2);
    } finally {
      store.close();
    }
  });

  it("keyword search returns at most one result for deduplicated content", () => {
    const store = createMemoryStore("dedup-user3", tmpDir);
    try {
      store.addFact("unique phrase xyz", "run1", null);
      store.addFact("unique phrase xyz", "run2", null);
      store.addFact("unique phrase xyz", "run3", null);

      const results = store.searchKeyword("unique phrase xyz", 10);
      // At most one row should exist
      expect(results.length).toBeLessThanOrEqual(1);
    } finally {
      store.close();
    }
  });

  it("removeFact removes the deduplicated entry", () => {
    const store = createMemoryStore("dedup-user4", tmpDir);
    try {
      const id = store.addFact("something to remove", "test", null);
      store.addFact("something to remove", "test", null); // dedup — same ID
      store.removeFact(id);

      const results = store.searchKeyword("something to remove", 10);
      expect(results).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
