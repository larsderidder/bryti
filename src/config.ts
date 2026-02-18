/**
 * Config loading and validation.
 *
 * Loads config.yml from data directory, substitutes ${ENV_VAR} references,
 * validates required fields.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

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
    system_prompt: string;
    model: string;
    /** Ordered list of fallback model strings to try when the primary fails. */
    fallback_models: string[];
  };
  telegram: {
    token: string;
    allowed_users: number[];
  };
  whatsapp: {
    enabled: boolean;
  };
  models: {
    providers: ProviderConfig[];
  };
  tools: {
    web_search: { enabled: boolean; api_key: string };
    fetch_url: { enabled: boolean; timeout_ms: number };
    files: { enabled: boolean; base_dir: string };
  };
  cron: CronJob[];
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
  return text.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
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
    },
    models: {
      providers: [],
      ...(substituted.models as object),
    },
    tools: {
      web_search: { enabled: true, api_key: "", ...(substituted.tools as Record<string, unknown>)?.web_search as object },
      fetch_url: { enabled: true, timeout_ms: 10000, ...(substituted.tools as Record<string, unknown>)?.fetch_url as object },
      files: { enabled: true, base_dir: path.join(dataDir, "files"), ...(substituted.tools as Record<string, unknown>)?.files as object },
    },
    cron: (substituted.cron as CronJob[]) || [],
    data_dir: dataDir,
  };

  for (const provider of config.models.providers) {
    provider.models = provider.models.map((model) => ({
      ...model,
      cost: normalizeModelCost(model.cost),
    }));
  }

  // Validate required fields
  if (!config.telegram.token && !config.whatsapp.enabled) {
    throw new Error("Config: telegram.token is required (or enable whatsapp)");
  }
  if (!config.agent.model) {
    throw new Error("Config: agent.model is required");
  }
  if (config.models.providers.length === 0) {
    throw new Error("Config: at least one model provider is required");
  }

  return config;
}

/**
 * Ensure data directories exist.
 */
export function ensureDataDirs(config: Config): void {
  const dirs = [
    config.data_dir,
    path.join(config.data_dir, "history"),
    path.join(config.data_dir, "files"),
    path.join(config.data_dir, "usage"),
  ];

  // WhatsApp auth directory (always create in case user adds WhatsApp later)
  dirs.push(path.join(config.data_dir, "whatsapp-auth"));

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
