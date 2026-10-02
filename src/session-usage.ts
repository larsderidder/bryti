import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { calculateCostUsd, resolveModelCost } from "./usage.js";

/** Reject malformed telemetry instead of poisoning totals with NaN or negative counts. */
function finiteAmount(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
    return value;
  }
  return 0;
}

/** Account from newly appended canonical entries, not the shortened provider projection. */
export function collectSessionUsage(config: Config, entries: readonly SessionEntry[]) {
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    cost_usd: 0, model_calls: 0, usage_operations: 0 };
  const models = new Map<string, typeof totals>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    let usage: Usage | undefined;
    let provider: string | undefined;
    let model: string | undefined;
    let kind: string = entry.type;
    let modelCalls = 0;
    if (entry.type === "message" && entry.message.role === "assistant") {
      usage = entry.message.usage;
      provider = entry.message.provider;
      model = entry.message.model;
      modelCalls = 1;
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      usage = entry.message.usage;
      kind = "tool_result";
    } else if (entry.type === "usage") {
      usage = entry.usage;
      provider = entry.provider;
      model = entry.model;
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      usage = entry.usage;
    }
    if (!usage) {
      continue;
    }
    const input = finiteAmount(usage.input);
    const output = finiteAmount(usage.output);
    const cacheRead = finiteAmount(usage.cacheRead);
    const cacheWrite = finiteAmount(usage.cacheWrite);
    const prices = resolveModelCost(config, provider, model);
    let cost = finiteAmount(usage.cost?.total);
    if (prices) {
      cost = finiteAmount(calculateCostUsd(input, output, prices)) + finiteAmount(usage.cost?.cacheRead) + finiteAmount(usage.cost?.cacheWrite);
    }
    let key = `auxiliary/${kind}`;
    if (provider && model) {
      key = `${provider}/${model}`;
    }
    const perModel = models.get(key) ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
      cache_write_tokens: 0, cost_usd: 0, model_calls: 0, usage_operations: 0 };
    for (const total of [totals, perModel]) {
      total.input_tokens += input;
      total.output_tokens += output;
      total.cache_read_tokens += cacheRead;
      total.cache_write_tokens += cacheWrite;
      total.cost_usd = Math.round((total.cost_usd + cost) * 1_000_000) / 1_000_000;
      total.model_calls += modelCalls;
      total.usage_operations++;
    }
    models.set(key, perModel);
  }
  return { ...totals, models: [...models].map(([model, usage]) => ({ model, ...usage })) };
}
