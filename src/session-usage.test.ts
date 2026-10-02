import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { collectSessionUsage } from "./session-usage.js";
import type { Config } from "./config.js";

const config = { models: { providers: [] } } as unknown as Config;
const usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, reasoning: 3, totalTokens: 135,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } };

describe("complete native session usage", () => {
  it("counts every assistant, nested tool usage, compaction, and auxiliary usage exactly once", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ ...fauxAssistantMessage("First"), usage });
    manager.appendMessage({ ...fauxAssistantMessage("Second"), usage });
    manager.appendMessage({ role: "toolResult", toolName: "codemode", toolCallId: "fixture", isError: false,
      content: [{ type: "text", text: "Nested model result" }], timestamp: 1, usage });
    manager.appendUsage("cache_warm", "fixture", "fixture", usage);
    manager.appendCompaction("Summary", manager.getLeafId(), 100, {}, false, usage);
    expect(collectSessionUsage(config, manager.getEntries())).toMatchObject({ input_tokens: 50, output_tokens: 25,
      cache_read_tokens: 500, cache_write_tokens: 100, cost_usd: 5, model_calls: 2, usage_operations: 5 });
  });

  it("uses per-response model rates across fallbacks while retaining native cache costs", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ ...fauxAssistantMessage("First"), provider: "fixture", model: "cheap", usage });
    manager.appendMessage({ ...fauxAssistantMessage("Fallback"), provider: "fixture", model: "expensive", usage });
    const prices = { models: { providers: [{ name: "fixture", models: [
      { id: "cheap", cost: { input: 10000, output: 20000 } },
      { id: "expensive", cost: { input: 20000, output: 40000 } },
    ] }] } } as unknown as Config;
    expect(collectSessionUsage(prices, manager.getEntries()).cost_usd).toBe(2);
    expect(collectSessionUsage(prices, manager.getEntries()).models).toHaveLength(2);
  });

  it("does not count edits or reasoning tokens twice, and ignores malformed usage numbers", () => {
    const manager = SessionManager.inMemory();
    const id = manager.appendMessage({ ...fauxAssistantMessage("Result"), usage });
    manager.appendContextEdit(id, { content: "Shortened" });
    manager.appendUsage("future-operation", "fixture", "fixture", { ...usage, input: Number.NaN, output: -1, cacheRead: Number.POSITIVE_INFINITY,
      cost: { ...usage.cost, total: Number.NaN } });
    const result = collectSessionUsage(config, manager.getEntries());
    expect(result).toMatchObject({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, cache_write_tokens: 40, cost_usd: 1 });
  });
});
