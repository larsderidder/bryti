import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { createScheduler } from "./scheduler.js";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync("/tmp/pibot-scheduler-test-");
}

function makeConfig(cron: Config["cron"] = []): Config {
  return {
    agent: {
      name: "TestBot",
      system_prompt: "test",
      model: "test/model",
      fallback_models: [],
    },
    telegram: { token: "tok", allowed_users: [12345] },
    whatsapp: { enabled: false, allowed_users: [] },
    models: { providers: [] },
    tools: {
      web_search: { enabled: false, searxng_url: "" },
      fetch_url: { enabled: false, timeout_ms: 5000 },
      files: { enabled: false, base_dir: "/tmp" },
    },
    cron,
    data_dir: "/tmp",
  } as Config;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Scheduler", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts and stops without error when config has no cron jobs", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it("starts config-driven cron jobs", () => {
    const config = {
      ...makeConfig([{ schedule: "0 8 * * *", message: "config job" }]),
      data_dir: tempDir,
    };
    const scheduler = createScheduler(config, vi.fn());
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it("starts projection jobs when a primary user is configured", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    const logs = consoleSpy.mock.calls.map((c) => c[0]);
    expect(logs.some((l: string) => l.includes("Daily review scheduled"))).toBe(true);
    expect(logs.some((l: string) => l.includes("Exact-time check scheduled every 5 minutes"))).toBe(true);

    scheduler.stop();
    consoleSpy.mockRestore();
  });

  it("does not start projection jobs when no primary user is configured", () => {
    const config = {
      ...makeConfig(),
      telegram: { token: "tok", allowed_users: [] },
      data_dir: tempDir,
    } as Config;
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    const logs = consoleSpy.mock.calls.map((c) => c[0]);
    expect(logs.some((l: string) => l.includes("Daily review scheduled"))).toBe(false);

    scheduler.stop();
    consoleSpy.mockRestore();
  });
});
