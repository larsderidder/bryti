import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createUsageTracker, calculateCostUsd, resolveModelCost } from "../src/usage.js";
import type { Config } from "../src/config.js";

describe("UsageTracker", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/pibot-usage-test-");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should append usage records to jsonl", async () => {
    const tracker = createUsageTracker(tempDir);
    await tracker.append({
      user_id: "user-1",
      model: "test/model",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.001,
      latency_ms: 123,
    });

    const today = new Date().toISOString().split("T")[0];
    const usagePath = path.join(tempDir, "usage", `${today}.jsonl`);
    expect(fs.existsSync(usagePath)).toBe(true);

    const lines = fs.readFileSync(usagePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as {
      user_id: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      latency_ms: number;
      timestamp: string;
    };
    expect(record.user_id).toBe("user-1");
    expect(record.model).toBe("test/model");
    expect(record.input_tokens).toBe(100);
    expect(record.output_tokens).toBe(50);
    expect(record.cost_usd).toBe(0.001);
    expect(record.latency_ms).toBe(123);
    expect(record.timestamp).toBeDefined();
  });

  it("should summarize per day and per user", async () => {
    const tracker = createUsageTracker(tempDir);
    await tracker.append({
      user_id: "user-1",
      model: "test/model",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.0025,
      latency_ms: 100,
    });
    await tracker.append({
      user_id: "user-2",
      model: "test/model",
      input_tokens: 200,
      output_tokens: 80,
      cost_usd: 0.005,
      latency_ms: 200,
    });
    await tracker.append({
      user_id: "user-1",
      model: "test/model",
      input_tokens: 20,
      output_tokens: 10,
      cost_usd: 0.0004,
      latency_ms: 150,
    });

    const summary = await tracker.summarize();
    expect(summary.total_messages).toBe(3);
    expect(summary.total_input_tokens).toBe(320);
    expect(summary.total_output_tokens).toBe(140);
    expect(summary.total_cost_usd).toBe(0.0079);
    expect(summary.by_user["user-1"].messages).toBe(2);
    expect(summary.by_user["user-1"].input_tokens).toBe(120);
    expect(summary.by_user["user-1"].output_tokens).toBe(60);
    expect(summary.by_user["user-1"].cost_usd).toBe(0.0029);
    expect(summary.by_user["user-2"].messages).toBe(1);
  });
});

describe("usage cost helpers", () => {
  const config: Config = {
    agent: {
      name: "Pibot",
      system_prompt: "test",
      model: "provider-a/model-a",
    },
    telegram: {
      token: "x",
      allowed_users: [],
    },
    whatsapp: {
      enabled: false,
    },
    models: {
      providers: [
        {
          name: "provider-a",
          base_url: "https://example.com",
          api: "openai-completions",
          api_key: "k",
          models: [
            {
              id: "model-a",
              cost: { input: 2, output: 8 },
            },
          ],
        },
      ],
    },
    tools: {
      web_search: { enabled: false, api_key: "" },
      fetch_url: { enabled: false, timeout_ms: 1000 },
      files: { enabled: false, base_dir: "/tmp" },
    },
    cron: [],
    data_dir: "/tmp",
  };

  it("should resolve model cost from provider/model tuple", () => {
    const cost = resolveModelCost(config, "provider-a", "model-a");
    expect(cost).toEqual({ input: 2, output: 8 });
  });

  it("should resolve model cost from fully qualified model id", () => {
    const cost = resolveModelCost(config, undefined, "provider-a/model-a");
    expect(cost).toEqual({ input: 2, output: 8 });
  });

  it("should calculate cost in usd using per-million rates", () => {
    const usd = calculateCostUsd(1000, 500, { input: 2, output: 8 });
    expect(usd).toBe(0.006);
  });
});
