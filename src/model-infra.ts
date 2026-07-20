/**
 * Shared model infrastructure: ModelRuntime, ModelRegistry, models.json
 * generation, and model string resolution. Used by the main agent, workers,
 * reflection, and the guardrail.
 *
 * This module generates models.json from Bryti's config, initializes pi's
 * model and authentication runtime, and resolves configured provider/model
 * strings. OAuth credentials come from pi's auth.json; configured API keys
 * are applied as in-memory runtime overrides and are not written to models.json.
 */

import fs from "node:fs";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelInfra {
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
  agentDir: string;
}

export interface ModelInfraOptions {
  /** Which caller is using the infrastructure. Used for future policy and log labels. */
  purpose?: "main" | "worker" | "reflection" | "guardrail";
}

// ---------------------------------------------------------------------------
// models.json generation
// ---------------------------------------------------------------------------

/**
 * Generate models.json from bryti config so pi's ModelRegistry discovers
 * all configured providers and models.
 */
function generateModelsJson(config: Config, agentDir: string): void {
  const modelsJsonPath = path.join(agentDir, "models.json");

  const providers: Record<string, unknown> = {};

  for (const provider of config.models.providers) {
    // A non-empty placeholder keeps custom models discoverable. Real API keys
    // stay in memory instead of models.json (ASVS 13.3.1). OAuth comes from
    // pi's auth.json.
    const apiKey = "oauth";

    const providerEntry: Record<string, unknown> = {
      api: provider.api || "openai-completions",
      apiKey: apiKey,
      ...(provider.headers && { headers: provider.headers }),
      models: provider.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.context_window || 200000,
        maxTokens: m.max_tokens || 32000,
        input: m.input ?? ["text", "image"],
        ...(m.api && { api: m.api }),
        ...(m.cost && { cost: m.cost }),
        ...(m.compat && { compat: m.compat }),
      })),
    };

    // Preserve built-in provider defaults when base_url is empty.
    // Setting a synthetic fallback URL here breaks providers like
    // openai-codex and google-antigravity, which have custom transports.
    if (provider.base_url && provider.base_url.trim().length > 0) {
      providerEntry.baseUrl = provider.base_url;
    }

    providers[provider.name] = providerEntry;
  }

  fs.writeFileSync(
    modelsJsonPath,
    JSON.stringify({ providers }, null, 2),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Infrastructure creation
// ---------------------------------------------------------------------------

/**
 * Create the model and authentication infrastructure shared by every caller.
 * Configured API keys take precedence over credentials in pi's auth.json.
 */
export async function createModelInfra(
  config: Config,
  _options: ModelInfraOptions = {},
): Promise<ModelInfra> {
  const agentDir = path.join(config.data_dir, ".pi");
  fs.mkdirSync(agentDir, { recursive: true });

  generateModelsJson(config, agentDir);

  const modelRuntime = await ModelRuntime.create({
    modelsPath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });

  for (const provider of config.models.providers) {
    if (provider.api_key) {
      await modelRuntime.setRuntimeApiKey(provider.name, provider.api_key);
    }
  }

  const modelRegistry = new ModelRegistry(modelRuntime);
  return { modelRuntime, modelRegistry, agentDir };
}

export function createBrytiSettingsManager(
  config: Config,
  cwd: string,
  agentDir: string,
): SettingsManager {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const providerTimeouts = config.models.providers
    .map((provider) => provider.timeout_ms)
    .filter((value): value is number => typeof value === "number");
  const providerRetries = config.models.providers
    .map((provider) => provider.max_retries)
    .filter((value): value is number => typeof value === "number");
  const providerRetryDelays = config.models.providers
    .map((provider) => provider.max_retry_delay_ms)
    .filter((value): value is number => typeof value === "number");

  settingsManager.applyOverrides({
    ...(config.models.http_proxy ? { httpProxy: config.models.http_proxy } : {}),
    ...(config.models.http_idle_timeout_ms ? { httpIdleTimeoutMs: config.models.http_idle_timeout_ms } : {}),
    ...(config.models.websocket_connect_timeout_ms ? { websocketConnectTimeoutMs: config.models.websocket_connect_timeout_ms } : {}),
    ...(
      providerTimeouts.length > 0 || providerRetries.length > 0 || providerRetryDelays.length > 0
        ? {
            retry: {
              provider: {
                ...(providerTimeouts.length > 0 ? { timeoutMs: Math.max(...providerTimeouts) } : {}),
                ...(providerRetries.length > 0 ? { maxRetries: Math.max(...providerRetries) } : {}),
                ...(providerRetryDelays.length > 0 ? { maxRetryDelayMs: Math.max(...providerRetryDelays) } : {}),
              },
            },
          }
        : {}
    ),
  });
  return settingsManager;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a "provider/modelId" string against the registry.
 *
 * Resolution order:
 *   1. Exact match via ModelRegistry.find(provider, modelId).
 *   2. Fuzzy match: scans all available models for one whose id contains
 *      modelId as a substring. This handles cases where model IDs in the
 *      registry include version suffixes (e.g. "claude-3-5-sonnet-20241022")
 *      that the shorter config string ("claude-3-5-sonnet") doesn't carry.
 *
 * Returns null if neither strategy finds a match.
 */
export function resolveModel(
  modelString: string,
  modelRegistry: ModelRegistry,
): Model<any> | null {
  const [providerName, modelId] = modelString.includes("/")
    ? modelString.split("/")
    : [modelString, modelString];

  let model = modelRegistry.find(providerName, modelId);
  if (!model) {
    const available = modelRegistry.getAvailable();
    model = available.find(
      (m) => m.provider === providerName && m.id.includes(modelId),
    );
  }
  return model ?? null;
}

/**
 * Resolve the first usable model from an ordered list of "provider/modelId"
 * candidate strings.
 *
 * Used by the guardrail to pick a model without requiring a full config
 * context: it passes its ordered preference list and gets back whatever is
 * actually available in the registry. Returns the first successful resolution,
 * not the "best" or highest-capability model. Returns null if no candidate
 * resolves.
 */
export function resolveFirstModel(
  candidates: string[],
  modelRegistry: ModelRegistry,
): Model<any> | null {
  for (const candidate of candidates) {
    const model = resolveModel(candidate, modelRegistry);
    if (model) return model;
  }
  return null;
}
