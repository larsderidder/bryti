/**
 * Shared model infrastructure: AuthStorage, ModelRegistry, models.json
 * generation, and model string resolution. Used by the main agent, workers,
 * reflection, and the guardrail.
 */

import fs from "node:fs";
import os from "node:os";
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
 * Generate models.json from bryti config so pi's ModelRegistry discovers
 * all configured providers and models.
 */
function generateModelsJson(config: Config, agentDir: string): void {
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
        contextWindow: m.context_window || 200000,
        maxTokens: m.max_tokens || 32000,
        ...(m.api && { api: m.api }),
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
// Claude CLI credential bridge
// ---------------------------------------------------------------------------

/**
 * Claude CLI credential shape in ~/.claude/.credentials.json.
 */
interface ClaudeCliCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

/**
 * Seed AuthStorage with Anthropic credentials from the Claude CLI credential
 * file (~/.claude/.credentials.json) if no Anthropic credential is already
 * present in auth.json.
 *
 * Claude CLI is the primary auth source for users who have it installed.
 * Pi auth.json is used as the fallback (for users who logged in via `pi login`).
 *
 * Once seeded, pi's AuthStorage manages the refresh lifecycle going forward:
 * it will auto-refresh the token using the refresh token when it expires.
 */
function seedFromClaudeCliIfNeeded(authStorage: AuthStorage): void {
  // Already have Anthropic creds — nothing to do
  if (authStorage.has("anthropic")) {
    return;
  }

  const claudeCredPath = path.join(os.homedir(), ".claude", ".credentials.json");
  let raw: string;
  try {
    raw = fs.readFileSync(claudeCredPath, "utf-8");
  } catch {
    // File doesn't exist or isn't readable — Claude CLI not installed
    return;
  }

  let parsed: ClaudeCliCredentials;
  try {
    parsed = JSON.parse(raw) as ClaudeCliCredentials;
  } catch {
    console.warn("[auth] ~/.claude/.credentials.json is not valid JSON, skipping");
    return;
  }

  const creds = parsed.claudeAiOauth;
  if (!creds?.accessToken || !creds?.refreshToken) {
    console.warn("[auth] ~/.claude/.credentials.json has no usable claudeAiOauth credentials, skipping");
    return;
  }

  // Convert Claude CLI format → pi AuthStorage OAuthCredential format:
  //   Claude CLI: { accessToken, refreshToken, expiresAt }
  //   pi:         { type: "oauth", access, refresh, expires }
  authStorage.set("anthropic", {
    type: "oauth",
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt ?? Date.now(),
  });

  console.log("[auth] Seeded Anthropic credentials from Claude CLI (~/.claude/.credentials.json)");
}

// ---------------------------------------------------------------------------
// Infrastructure creation
// ---------------------------------------------------------------------------

/**
 * Create the auth and model registry infrastructure from config. Generates
 * models.json, sets up AuthStorage with runtime API keys, and initializes
 * ModelRegistry. Shared by everything that talks to an LLM.
 *
 * Auth priority for Anthropic:
 *   1. Claude CLI credentials (~/.claude/.credentials.json) — primary source
 *   2. Pi auth.json (~/.pi/agent/auth.json) — fallback for pi CLI users
 *   3. Explicit api_key in config — always wins as a runtime override
 */
export function createModelInfra(config: Config): ModelInfra {
  const agentDir = path.join(config.data_dir, ".pi");
  fs.mkdirSync(agentDir, { recursive: true });

  generateModelsJson(config, agentDir);

  // Auth: start with ~/.pi/agent/auth.json (pi CLI OAuth creds), then
  // seed from Claude CLI if no Anthropic credential is present there.
  // AuthStorage uses file-level locking so concurrent token refreshes are safe.
  const authStorage = new AuthStorage();

  // Seed from Claude CLI before applying runtime overrides, so an explicit
  // api_key in config still wins (setRuntimeApiKey takes precedence).
  seedFromClaudeCliIfNeeded(authStorage);

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
 * Resolve a "provider/modelId" string against the registry. Tries exact
 * match first, then fuzzy (modelId as substring). Returns null if not found.
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
