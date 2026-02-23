/**
 * Per-message token usage tracking.
 *
 * Records input tokens, output tokens, model, cost in USD, and latency for
 * every agent response. Entries are appended to daily JSONL files under
 * data/usage/. Used for cost monitoring and operator visibility into model
 * spending over time.
 */

import fs from "node:fs";
import path from "node:path";
import type { Config, ModelEntry } from "./config.js";

export interface UsageRecord {
  timestamp: string;
  user_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
}

export interface UsageSummary {
  date: string;
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  by_user: Record<
    string,
    {
      messages: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }
  >;
}

export interface UsageTracker {
  append(entry: Omit<UsageRecord, "timestamp">): Promise<void>;
  summarize(date?: string): Promise<UsageSummary>;
}

function toDateString(date: Date): string {
  return date.toISOString().split("T")[0];
}

// Round to 6 decimal places ($0.000001 precision). This prevents floating-point
// drift when accumulating many small cost values in running totals.
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function calculateCostUsd(
  inputTokens: number,
  outputTokens: number,
  cost?: ModelEntry["cost"],
): number {
  if (!cost) return 0;
  // cost.input / cost.output are prices per million tokens; divide by 1,000,000
  // to get the per-token rate before multiplying by the actual token count.
  const input = (inputTokens * cost.input) / 1_000_000;
  const output = (outputTokens * cost.output) / 1_000_000;
  return roundUsd(input + output);
}

/**
 * Look up a model's cost config using a three-step cascade.
 *
 * The model string returned by the SDK may differ from the config format in
 * two ways: (1) it may carry an embedded "provider/model" prefix, or (2) the
 * provider context may only be known separately. The cascade handles both:
 *
 * Step 1 — explicit provider + bare model id: use the provider hint (if any)
 *   and strip any embedded prefix from the model string.
 * Step 2 — embedded provider prefix: parse "provider/model" from the model
 *   string itself and look up that pair.
 * Step 3 — bare id across all providers: fall back to searching every
 *   configured provider for a model whose id matches the full model string.
 */
export function resolveModelCost(
  config: Config,
  provider: string | undefined,
  model: string | undefined,
): ModelEntry["cost"] | undefined {
  if (!model) return undefined;

  // Parse an optional "provider/model" prefix from the model string.
  const slashIdx = model.indexOf("/");
  const embeddedProvider = slashIdx !== -1 ? model.slice(0, slashIdx) : undefined;
  const bareModel = slashIdx !== -1 ? model.slice(slashIdx + 1) : model;

  // Candidate (providerName, modelId) pairs to try in order.
  const candidates: Array<[string | undefined, string]> = [
    [provider, bareModel],
    [embeddedProvider, bareModel],
    [undefined, model], // bare id across all providers
  ];

  for (const [providerName, modelId] of candidates) {
    const providers = providerName
      ? config.models.providers.filter((p) => p.name === providerName)
      : config.models.providers;
    for (const p of providers) {
      const cost = p.models.find((m) => m.id === modelId)?.cost;
      if (cost) return cost;
    }
  }

  return undefined;
}

export function createUsageTracker(dataDir: string): UsageTracker {
  const usageDir = path.join(dataDir, "usage");
  fs.mkdirSync(usageDir, { recursive: true });

  function usageFilePath(date: string): string {
    return path.join(usageDir, `${date}.jsonl`);
  }

  return {
    async append(entry: Omit<UsageRecord, "timestamp">): Promise<void> {
      const timestamp = new Date().toISOString();
      const date = toDateString(new Date());
      const record: UsageRecord = { timestamp, ...entry };
      fs.appendFileSync(usageFilePath(date), `${JSON.stringify(record)}\n`, "utf-8");
    },

    async summarize(date?: string): Promise<UsageSummary> {
      const day = date || toDateString(new Date());
      const filePath = usageFilePath(day);
      const summary: UsageSummary = {
        date: day,
        total_messages: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost_usd: 0,
        by_user: {},
      };

      if (!fs.existsSync(filePath)) {
        return summary;
      }

      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as UsageRecord;
          summary.total_messages += 1;
          summary.total_input_tokens += record.input_tokens;
          summary.total_output_tokens += record.output_tokens;
          summary.total_cost_usd = roundUsd(summary.total_cost_usd + record.cost_usd);

          const userSummary = summary.by_user[record.user_id] || {
            messages: 0,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0,
          };
          userSummary.messages += 1;
          userSummary.input_tokens += record.input_tokens;
          userSummary.output_tokens += record.output_tokens;
          userSummary.cost_usd = roundUsd(userSummary.cost_usd + record.cost_usd);
          summary.by_user[record.user_id] = userSummary;
        } catch {
          // Skip malformed JSONL entries.
        }
      }

      return summary;
    },
  };
}
