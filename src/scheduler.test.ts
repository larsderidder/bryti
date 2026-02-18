import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createScheduler } from "./scheduler.js";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync("/tmp/pibot-scheduler-test-");
}

function makeConfig(overrides: Partial<Config["agent"]> = {}, cron: Config["cron"] = []): Config {
  return {
    agent: {
      name: "TestBot",
      system_prompt: "test",
      model: "test/model",
      fallback_models: [],
      ...overrides,
    },
    telegram: { token: "tok", allowed_users: [12345] },
    whatsapp: { enabled: false },
    models: { providers: [] },
    tools: {
      web_search: { enabled: false, api_key: "" },
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

describe("Scheduler - agent-managed schedules", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts with empty list when no schedules.json exists", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    expect(scheduler.list()).toEqual([]);
    scheduler.stop();
  });

  it("creates a schedule and returns a record with an id", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    const record = scheduler.create({
      schedule: "0 8 * * *",
      message: "Good morning!",
      description: "Daily greeting",
      userId: "user-1",
      channelId: "12345",
    });

    expect(record.id).toBeDefined();
    expect(record.schedule).toBe("0 8 * * *");
    expect(record.message).toBe("Good morning!");
    expect(record.description).toBe("Daily greeting");
    expect(record.enabled).toBe(true);
    expect(record.created_at).toBeDefined();

    scheduler.stop();
  });

  it("persists created schedules to schedules.json", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    scheduler.create({
      schedule: "0 8 * * *",
      message: "test",
      description: "test desc",
      userId: "u1",
      channelId: "c1",
    });

    scheduler.stop();

    const saved = JSON.parse(
      fs.readFileSync(path.join(tempDir, "schedules.json"), "utf-8"),
    );
    expect(Array.isArray(saved)).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0].schedule).toBe("0 8 * * *");
  });

  it("lists all created schedules", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    scheduler.create({ schedule: "0 8 * * *", message: "a", description: "A", userId: "u", channelId: "c" });
    scheduler.create({ schedule: "0 9 * * *", message: "b", description: "B", userId: "u", channelId: "c" });

    const list = scheduler.list();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.message)).toEqual(["a", "b"]);

    scheduler.stop();
  });

  it("deletes a schedule by id", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    const record = scheduler.create({
      schedule: "0 8 * * *",
      message: "delete me",
      description: "temp",
      userId: "u",
      channelId: "c",
    });

    const deleted = scheduler.delete(record.id);
    expect(deleted).toBe(true);
    expect(scheduler.list()).toHaveLength(0);

    scheduler.stop();
  });

  it("returns false when deleting a non-existent id", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    expect(scheduler.delete("no-such-id")).toBe(false);

    scheduler.stop();
  });

  it("persists deletion to schedules.json", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    const r1 = scheduler.create({ schedule: "0 8 * * *", message: "keep", description: "k", userId: "u", channelId: "c" });
    const r2 = scheduler.create({ schedule: "0 9 * * *", message: "delete", description: "d", userId: "u", channelId: "c" });

    scheduler.delete(r2.id);
    scheduler.stop();

    const saved = JSON.parse(
      fs.readFileSync(path.join(tempDir, "schedules.json"), "utf-8"),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(r1.id);
  });

  it("reloads persisted schedules on restart", () => {
    const config = { ...makeConfig(), data_dir: tempDir };

    // First instance: create a schedule
    const s1 = createScheduler(config, vi.fn());
    s1.start();
    const record = s1.create({
      schedule: "0 8 * * *",
      message: "persisted",
      description: "test",
      userId: "u",
      channelId: "c",
    });
    s1.stop();

    // Second instance: should load from disk
    const s2 = createScheduler(config, vi.fn());
    s2.start();

    const list = s2.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(record.id);
    expect(list[0].message).toBe("persisted");

    s2.stop();
  });

  it("throws (via croner) when given an invalid cron expression", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    expect(() =>
      scheduler.create({
        schedule: "not-a-cron",
        message: "boom",
        description: "bad",
        userId: "u",
        channelId: "c",
      }),
    ).toThrow();

    scheduler.stop();
  });
});

describe("Scheduler - config-driven jobs", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts without error when config has no cron jobs", () => {
    const config = { ...makeConfig({}, []), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it("does not add config jobs to the agent-managed list", () => {
    const config = {
      ...makeConfig({}, [{ schedule: "0 8 * * *", message: "config job" }]),
      data_dir: tempDir,
    };
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    // list() returns only agent-managed records
    expect(scheduler.list()).toHaveLength(0);

    scheduler.stop();
  });
});
