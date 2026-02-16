import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCronScheduler } from "../src/cron.js";
import type { Config } from "../src/config.js";

describe("CronScheduler", () => {
  let config: Config;

  beforeEach(() => {
    config = {
      agent: { name: "Test", system_prompt: "", model: "test" },
      telegram: { token: "test", allowed_users: [] },
      models: { providers: [] },
      tools: { web_search: { enabled: false, api_key: "" }, fetch_url: { enabled: false, timeout_ms: 10000 }, files: { enabled: false, base_dir: "" } },
      data_dir: "/tmp/test",
      cron: [
        { schedule: "* * * * *", message: "Test cron job" },
      ],
    };
  });

  it("should create scheduler without errors", () => {
    const scheduler = createCronScheduler(config, async () => {});
    expect(scheduler).toBeDefined();
  });

  it("should start and stop", () => {
    const scheduler = createCronScheduler(config, async () => {});
    scheduler.start();
    scheduler.stop();
  });

  it("should handle empty cron list", () => {
    config.cron = [];
    const scheduler = createCronScheduler(config, async () => {});
    scheduler.start();
    scheduler.stop();
  });
});
