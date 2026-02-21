/**
 * Config loading and validation.
 *
 * Loads config.yml from data directory, substitutes ${ENV_VAR} references,
 * validates required fields.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ActiveHoursConfig } from "./active-hours.js";

export type { ActiveHoursConfig };

export interface ProviderConfig {
  name: string;
  base_url: string;
  api: string;
  api_key: string;
  models: ModelEntry[];
}

export interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  context_window?: number;
  max_tokens?: number;
  cost?: { input: number; output: number };
  compat?: Record<string, unknown>;
}

export interface CronJob {
  schedule: string;
  message: string;
}

export interface Config {
  agent: {
    name: string;
    /** Additional content prepended to the system prompt. Persona, standing
     *  instructions, or context about the user. The framework adds memory,
     *  tool descriptions, and all other sections automatically. */
    system_prompt: string;
    model: string;
    /** Ordered list of fallback model strings to try when the primary fails. */
    fallback_models: string[];
    /** IANA timezone string, e.g. "Europe/Amsterdam". Injected into the system
     *  prompt so the agent resolves relative time expressions correctly.
     *  Defaults to UTC when omitted. */
    timezone?: string;
    /** Model to use for the reflection pass. Defaults to the primary model.
     *  Use this to pick a cheaper model for background reflection without
     *  affecting the main agent. Format: "provider/model-id". */
    reflection_model?: string;
  };
  telegram: {
    token: string;
    allowed_users: number[];
  };
  whatsapp: {
    enabled: boolean;
    /** Phone numbers in international format without +, e.g. ["31612345678"] */
    allowed_users: string[];
  };
  models: {
    providers: ProviderConfig[];
  };
  tools: {
    web_search: {
      enabled: boolean;
      /** SearXNG instance URL (no trailing slash). Workers only. */
      searxng_url: string;
    };
    fetch_url: { enabled: boolean; timeout_ms: number };
    files: { enabled: boolean; base_dir: string };
    workers: {
      /** Maximum number of workers that may run concurrently. Default: 3. */
      max_concurrent: number;
    };
  };
  cron: CronJob[];
  /** Optional active hours window. Scheduler callbacks skip firing outside it. */
  active_hours?: ActiveHoursConfig;
  data_dir: string;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeModelCost(cost: unknown): ModelEntry["cost"] | undefined {
  if (!cost || typeof cost !== "object") {
    return undefined;
  }
  const raw = cost as { input?: unknown; output?: unknown };
  const hasAny = raw.input !== undefined || raw.output !== undefined;
  if (!hasAny) {
    return undefined;
  }
  return {
    input: toFiniteNumber(raw.input) ?? 0,
    output: toFiniteNumber(raw.output) ?? 0,
  };
}

/**
 * Replace ${VAR} references with values from process.env.
 */
function substituteEnvVars(text: string): string {
  // Only substitute uppercase env-style names (e.g. ${TELEGRAM_BOT_TOKEN}).
  // This avoids clobbering template literals in prompt/examples like ${city}.
  return text.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, varName: string) => {
    const value = process.env[varName];
    if (value === undefined) {
      throw new Error(`Environment variable ${varName} is not set`);
    }
    return value;
  });
}

/**
 * Recursively substitute env vars in all string values of an object.
 */
function substituteDeep(obj: unknown): unknown {
  if (typeof obj === "string") {
    return substituteEnvVars(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteDeep);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteDeep(value);
    }
    return result;
  }
  return obj;
}

/**
 * Parse the tools section of the substituted config, applying defaults.
 */
function toolsFromConfig(substituted: Record<string, unknown>, dataDir: string): Config["tools"] {
  const raw = (substituted.tools ?? {}) as Record<string, unknown>;
  const webRaw = (raw.web_search ?? {}) as Record<string, unknown>;
  return {
    web_search: {
      enabled: webRaw.enabled !== false,
      searxng_url: (webRaw.searxng_url as string) ?? "https://search.xithing.eu",
    },
    fetch_url: {
      enabled: true,
      timeout_ms: 10000,
      ...(raw.fetch_url as object | undefined),
    },
    files: {
      enabled: true,
      base_dir: path.join(dataDir, "files"),
      ...(raw.files as object | undefined),
    },
    workers: {
      max_concurrent: 3,
      ...(raw.workers as object | undefined),
    },
  };
}

export function loadConfig(configPath?: string): Config {
  const dataDir = path.resolve(process.env.PIBOT_DATA_DIR || "./data");
  const cfgPath = configPath || path.join(dataDir, "config.yml");

  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Config file not found: ${cfgPath}`);
  }

  const raw = fs.readFileSync(cfgPath, "utf-8");
  const parsed = parseYaml(raw);
  const substituted = substituteDeep(parsed) as Record<string, unknown>;

  // Defaults
  const config: Config = {
    agent: {
      name: "Pibot",
      system_prompt: "You are a helpful personal assistant.",
      model: "",
      fallback_models: [],
      ...(substituted.agent as object),
    },
    telegram: {
      token: "",
      allowed_users: [],
      ...(substituted.telegram as object),
    },
    whatsapp: {
      enabled: (substituted.whatsapp as { enabled?: boolean })?.enabled ?? false,
      allowed_users: ((substituted.whatsapp as { allowed_users?: string[] })?.allowed_users ?? []).map(String),
    },
    models: {
      providers: [],
      ...(substituted.models as object),
    },
    tools: toolsFromConfig(substituted, dataDir),
    cron: (substituted.cron as CronJob[]) || [],
    active_hours: (substituted.active_hours as ActiveHoursConfig | undefined) ?? undefined,
    data_dir: dataDir,
  };

  for (const provider of config.models.providers) {
    provider.models = provider.models.map((model) => ({
      ...model,
      cost: normalizeModelCost(model.cost),
    }));
  }

  // Validate
  validateConfig(config);

  return config;
}

/**
 * Validate config at startup. Catches misconfigurations early rather than
 * failing at runtime (e.g., 30 minutes later when a cron job fires).
 */
function validateConfig(config: Config): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Required fields ---

  if (!config.telegram.token && !config.whatsapp.enabled) {
    errors.push("telegram.token is required (or enable whatsapp)");
  }
  if (!config.agent.model) {
    errors.push("agent.model is required");
  }
  if (config.models.providers.length === 0) {
    errors.push("at least one model provider is required");
  }

  // --- Primary model must be resolvable ---

  if (config.agent.model) {
    const [providerName] = config.agent.model.includes("/")
      ? config.agent.model.split("/", 2)
      : [config.agent.model];
    const provider = config.models.providers.find((p) => p.name === providerName);
    if (!provider) {
      errors.push(
        `agent.model "${config.agent.model}" references provider "${providerName}" ` +
        `which is not in models.providers. Available: ${config.models.providers.map((p) => p.name).join(", ")}`,
      );
    }
  }

  // --- Fallback models must reference known providers ---

  for (const fb of config.agent.fallback_models ?? []) {
    const [providerName] = fb.includes("/") ? fb.split("/", 2) : [fb];
    const provider = config.models.providers.find((p) => p.name === providerName);
    if (!provider) {
      warnings.push(
        `fallback_model "${fb}" references unknown provider "${providerName}"`,
      );
    }
  }

  // --- WhatsApp needs allowed_users if enabled ---

  if (config.whatsapp.enabled && config.whatsapp.allowed_users.length === 0) {
    warnings.push(
      "whatsapp is enabled but allowed_users is empty. " +
      "Anyone who finds the bot's number can message it.",
    );
  }

  // --- Web search needs a URL ---

  if (config.tools.web_search.enabled && !config.tools.web_search.searxng_url) {
    warnings.push("web_search is enabled but searxng_url is empty. Workers won't be able to search.");
  }

  // --- Emit ---

  for (const w of warnings) {
    console.warn(`Config warning: ${w}`);
  }
  if (errors.length > 0) {
    throw new Error(`Config errors:\n  - ${errors.join("\n  - ")}`);
  }
}

/**
 * Ensure data directories exist.
 */
export function ensureDataDirs(config: Config): void {
  const dirs = [
    config.data_dir,
    path.join(config.data_dir, "history"),
    path.join(config.data_dir, "files"),
    path.join(config.data_dir, "files", "extensions"),
    path.join(config.data_dir, "usage"),
    path.join(config.data_dir, "logs"),
    path.join(config.data_dir, ".pi"),
  ];

  // WhatsApp auth directory (always create in case user adds WhatsApp later)
  dirs.push(path.join(config.data_dir, "whatsapp-auth"));

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write .pi/settings.json so pi discovers agent-written extensions.
  // Pi's discoverAndLoadExtensions reads configuredPaths from settings and
  // scans directories for .ts/.js files.
  writeExtensionSettings(config);
}

/**
 * Write pi project settings that point to the agent's extension directory.
 *
 * Pi reads extensions from settings.extensions[] paths. We point it at
 * data/files/extensions/ where the agent writes extensions via file_write.
 */
function writeExtensionSettings(config: Config): void {
  const settingsPath = path.join(config.data_dir, ".pi", "settings.json");
  const extensionsDir = path.resolve(config.data_dir, "files", "extensions");

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      // Corrupted settings, overwrite
    }
  }

  const currentPaths = Array.isArray(settings.extensions) ? settings.extensions : [];
  if (!currentPaths.includes(extensionsDir)) {
    settings.extensions = [...currentPaths, extensionsDir];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }
}
