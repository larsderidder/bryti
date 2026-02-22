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

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function calculateCostUsd(
  inputTokens: number,
  outputTokens: number,
  cost?: ModelEntry["cost"],
): number {
  if (!cost) return 0;
  const input = (inputTokens * cost.input) / 1_000_000;
  const output = (outputTokens * cost.output) / 1_000_000;
  return roundUsd(input + output);
}

/**
 * Look up a model's cost config. Tries provider hint + bare id first, then
 * parses "provider/model" prefix, then searches all providers for bare id.
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
