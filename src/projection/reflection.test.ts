import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readRecentHistory,
  parseReflectionOutput,
  runReflection,
  type sdkComplete,
  type ReflectionOutput,
} from "./reflection.js";
import { createProjectionStore } from "./store.js";
import type { Config } from "../config.js";

// ---------------------------------------------------------------------------
// Minimal config stub
// ---------------------------------------------------------------------------

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
      fetch_url: { enabled: false, timeout_ms: 10000 },
      files: { enabled: false, base_dir: "" },
    },
    cron: [],
    data_dir: dataDir,
    active_hours: undefined as any,
  };
}

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-refl-test-"));
}

// ---------------------------------------------------------------------------
// readRecentHistory
// ---------------------------------------------------------------------------

describe("readRecentHistory", () => {
  let tmpDir: string;
  let historyDir: string;

  beforeEach(() => {
    tmpDir = makeDir();
    historyDir = path.join(tmpDir, "history");
    fs.mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeHistory(filename: string, entries: Array<{ role: string; content: string; timestamp: string }>): void {
    const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(path.join(historyDir, filename), lines);
  }

  it("returns empty when historyDir does not exist", () => {
    const result = readRecentHistory("/nonexistent/dir", 30);
    expect(result).toEqual([]);
  });

  it("returns messages within the window", () => {
    const recentTs = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();   // 1 hour ago
    const today = new Date().toISOString().slice(0, 10);

    writeHistory(`${today}.jsonl`, [
      { role: "user", content: "Recent message", timestamp: recentTs },
      { role: "assistant", content: "Recent reply", timestamp: recentTs },
      { role: "user", content: "Old message", timestamp: oldTs },
    ]);

    const result = readRecentHistory(historyDir, 30);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("Recent message");
    expect(result[1].content).toBe("Recent reply");
  });

  it("excludes tool and system messages", () => {
    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const today = new Date().toISOString().slice(0, 10);

    writeHistory(`${today}.jsonl`, [
      { role: "user", content: "Hello", timestamp: recentTs },
      { role: "tool", content: "tool output", timestamp: recentTs },
      { role: "system", content: "system msg", timestamp: recentTs },
    ]);

    const result = readRecentHistory(historyDir, 30);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("returns messages in chronological order", () => {
    const t1 = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const t2 = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const today = new Date().toISOString().slice(0, 10);

    writeHistory(`${today}.jsonl`, [
      { role: "user", content: "First", timestamp: t1 },
      { role: "assistant", content: "Second", timestamp: t2 },
    ]);

    const result = readRecentHistory(historyDir, 30);
    expect(result[0].content).toBe("First");
    expect(result[1].content).toBe("Second");
  });

  it("returns empty when no messages in window", () => {
    const oldTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const today = new Date().toISOString().slice(0, 10);

    writeHistory(`${today}.jsonl`, [
      { role: "user", content: "Old message", timestamp: oldTs },
    ]);

    const result = readRecentHistory(historyDir, 30);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseReflectionOutput
// ---------------------------------------------------------------------------

describe("parseReflectionOutput", () => {
  it("parses clean JSON", () => {
    const raw = JSON.stringify({
      project: [{ summary: "Dentist tomorrow", when: "2026-02-19", resolution: "day" }],
      archive: [{ content: "User prefers morning appointments" }],
    });
    const result = parseReflectionOutput(raw);
    expect(result.project).toHaveLength(1);
    expect(result.project[0].summary).toBe("Dentist tomorrow");
    expect(result.archive).toHaveLength(1);
  });

  it("strips markdown code fences", () => {
    const raw = "```json\n{\"project\":[],\"archive\":[]}\n```";
    const result = parseReflectionOutput(raw);
    expect(result.project).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  it("returns empty on unparseable input", () => {
    const result = parseReflectionOutput("not json at all");
    expect(result.project).toEqual([]);
    expect(result.archive).toEqual([]);
  });

  it("handles missing fields gracefully", () => {
    const raw = JSON.stringify({ project: [{ summary: "Meeting" }] });
    const result = parseReflectionOutput(raw);
    expect(result.project).toHaveLength(1);
    expect(result.archive).toEqual([]);
  });

  it("handles empty output", () => {
    const result = parseReflectionOutput('{"project":[],"archive":[]}');
    expect(result.project).toEqual([]);
    expect(result.archive).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runReflection
// ---------------------------------------------------------------------------

describe("runReflection", () => {
  let tmpDir: string;
  let config: Config;
  let historyDir: string;

  beforeEach(() => {
    tmpDir = makeDir();
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

  it("skips when there are no recent messages", async () => {
    const store = createProjectionStore("12345", tmpDir);
    try {
      const result = await runReflection(config, "12345", 30, store);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("no recent messages");
    } finally {
      store.close();
    }
  });

  it("skips when LLM call fails (no server available)", async () => {
    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeHistory([
      { role: "user", content: "I have a dentist appointment tomorrow at 10", timestamp: recentTs },
      { role: "assistant", content: "Got it!", timestamp: recentTs },
    ]);

    const store = createProjectionStore("12345", tmpDir);
    try {
      // Config points to localhost:9999 which doesn't exist — should not throw
      const result = await runReflection(config, "12345", 30, store);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("LLM error");
    } finally {
      store.close();
    }
  });

  it("writes projections returned by LLM (with injected completeFn)", async () => {
    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeHistory([
      { role: "user", content: "I have a dentist appointment on 2026-03-01", timestamp: recentTs },
      { role: "assistant", content: "I'll note that.", timestamp: recentTs },
    ]);

    const mockComplete: typeof sdkComplete = async () =>
      JSON.stringify({
        project: [
          { summary: "Dentist appointment", when: "2026-03-01", resolution: "day" },
        ],
        archive: [],
      } satisfies ReflectionOutput);

    const store = createProjectionStore("12345", tmpDir);
    try {
      const result = await runReflection(config, "12345", 30, store, mockComplete);
      expect(result.skipped).toBe(false);
      expect(result.projectionsAdded).toBe(1);
      expect(result.candidates[0].summary).toBe("Dentist appointment");

      // Verify it was actually written
      const upcoming = store.getUpcoming(90);
      expect(upcoming.some((p) => p.summary === "Dentist appointment")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("skips when no new messages since last reflection", async () => {
    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeHistory([
      { role: "user", content: "Hello", timestamp: recentTs },
    ]);

    // Run once (will fail LLM call, but still records the gate)
    // We need to simulate a prior successful reflection.
    // Do it by directly writing to the metadata table.
    const Database = (await import("better-sqlite3")).default;
    const userDir = path.join(tmpDir, "users", "12345");
    fs.mkdirSync(userDir, { recursive: true });
    const db = new Database(path.join(userDir, "memory.db"));
    db.exec("CREATE TABLE IF NOT EXISTS reflection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO reflection_meta (key, value) VALUES (?, ?)").run(
      "last_reflection",
      new Date().toISOString(), // Set last reflection to NOW
    );
    db.close();

    const store = createProjectionStore("12345", tmpDir);
    try {
      const result = await runReflection(config, "12345", 30, store);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("no new messages since last reflection");
    } finally {
      store.close();
    }
  });

  it("handles empty project array from LLM gracefully", async () => {
    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    writeHistory([
      { role: "user", content: "What's the weather?", timestamp: recentTs },
      { role: "assistant", content: "It's sunny!", timestamp: recentTs },
    ]);

    const mockComplete: typeof sdkComplete = async () => '{"project":[],"archive":[]}';

    const store = createProjectionStore("12345", tmpDir);
    try {
      const result = await runReflection(config, "12345", 30, store, mockComplete);
      expect(result.skipped).toBe(false);
      expect(result.projectionsAdded).toBe(0);
    } finally {
      store.close();
    }
  });
});
