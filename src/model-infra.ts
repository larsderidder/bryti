/**
 * Shared model infrastructure.
 *
 * Centralizes AuthStorage, ModelRegistry creation, models.json generation,
 * and model string resolution. Used by the main agent session, workers,
 * reflection, and the guardrail.
 */

import fs from "node:fs";
import path from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelInfra {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  agentDir: string;
}

// ---------------------------------------------------------------------------
// models.json generation
// ---------------------------------------------------------------------------

/**
 * Generate models.json from bryti config so the pi SDK's ModelRegistry
 * can discover all configured providers and models.
 */
export function generateModelsJson(config: Config, agentDir: string): void {
  const modelsJsonPath = path.join(agentDir, "models.json");

  const providers: Record<string, unknown> = {};

  for (const provider of config.models.providers) {
    if (provider.name === "groq") {
      continue;
    }

    // Providers without an api_key use OAuth from ~/.pi/agent/auth.json.
    // We still need to include them in models.json so custom model IDs
    // (not yet in SDK built-ins) are discoverable.
    // Use "oauth" as a placeholder apiKey; AuthStorage resolves the real token.
    const apiKey = provider.api_key || "oauth";

    providers[provider.name] = {
      baseUrl: provider.base_url || `https://api.${provider.name}.com`,
      api: provider.api || "openai-completions",
      apiKey: apiKey,
      models: provider.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.context_window || 131072,
        ...(m.api && { api: m.api }),
        ...(m.max_tokens && { maxTokens: m.max_tokens }),
        ...(m.cost && { cost: m.cost }),
        ...(m.compat && { compat: m.compat }),
      })),
    };
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
 * Create the auth and model registry infrastructure from config.
 *
 * Shared by the main agent, workers, reflection, and the guardrail.
 * Generates models.json, sets up AuthStorage with runtime API keys,
 * and initializes ModelRegistry.
 */
export function createModelInfra(config: Config): ModelInfra {
  const agentDir = path.join(config.data_dir, ".pi");
  fs.mkdirSync(agentDir, { recursive: true });

  generateModelsJson(config, agentDir);

  // Auth: share ~/.pi/agent/auth.json so bryti uses the same OAuth creds as
  // the pi CLI (Anthropic OAuth, etc.). AuthStorage uses file-level locking so
  // concurrent token refreshes from pi CLI and bryti are safe.
  const authStorage = new AuthStorage();
  for (const provider of config.models.providers) {
    if (provider.api_key) {
      authStorage.setRuntimeApiKey(provider.name, provider.api_key);
    }
  }

  const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
  modelRegistry.refresh();

  return { authStorage, modelRegistry, agentDir };
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a "provider/modelId" string against the model registry.
 * Returns null if the model is not found.
 *
 * Resolution order:
 *   1. Exact match via registry.find(provider, modelId)
 *   2. Fuzzy match: same provider, modelId as substring of available model ids
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
 * Resolve the first usable model from an ordered list of candidates.
 * Returns null if none resolve.
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
