/**
 * Config loading and validation.
 *
 * Loads config.yml from the data directory, substitutes ${ENV_VAR} references,
 * and validates required fields at startup so misconfigurations fail early.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import type { ActiveHoursConfig } from "./active-hours.js";

export type { ActiveHoursConfig };

export interface ProviderConfig {
  name: string;
  base_url: string;
  api: string;
  api_key: string;
  headers?: Record<string, string>;
  models: ModelEntry[];
}

export interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  context_window?: number;
  max_tokens?: number;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number };
  compat?: Record<string, unknown>;
}

export interface WorkerTypeConfig {
  /** Description shown in the system prompt so the agent knows when to use this type. */
  description?: string;
  /** Model override for this worker type. */
  model?: string;
  /** Tools available to this worker type. Default: ["web_search", "fetch_url"]. */
  tools?: string[];
  /** Timeout in seconds. Default: 3600. */
  timeout_seconds?: number;
}

export interface CronJob {
  schedule: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Agent definition types
//
// These fields come from agent.yml (or the agent: section of config.yml for
// backward compat). They describe what an agent IS, separate from the
// infrastructure that runs it.
// ---------------------------------------------------------------------------

/**
 * Tool groups that can be enabled for an agent.
 *
 * Each group corresponds to a set of tools registered at startup.
 * The default ("all") enables every group, matching the current behavior.
 */
export type ToolGroup =
  | "memory_core"
  | "memory_archival"
  | "memory_conversation"
  | "projections"
  | "workers"
  | "files"
  | "extensions_management"
  | "pi_sessions"
  | "system_log";

/** All tool groups — used as the default when no explicit list is given. */
export const ALL_TOOL_GROUPS: ToolGroup[] = [
  "memory_core",
  "memory_archival",
  "memory_conversation",
  "projections",
  "workers",
  "files",
  "extensions_management",
  "pi_sessions",
  "system_log",
];

/**
 * System prompt sections that can be included for an agent.
 *
 * The default ("all") includes every section, matching the current behavior.
 */
export type PromptSection =
  | "datetime"
  | "communication_style"
  | "image_handling"
  | "tools"
  | "extensions"
  | "skills"
  | "core_memory"
  | "projections"
  | "workers"
  | "first_conversation"
  | "silent_reply";

/** All prompt sections — used as the default when no explicit list is given. */
export const ALL_PROMPT_SECTIONS: PromptSection[] = [
  "datetime",
  "communication_style",
  "image_handling",
  "tools",
  "extensions",
  "skills",
  "core_memory",
  "projections",
  "workers",
  "first_conversation",
  "silent_reply",
];

/**
 * Tone of the agent's system prompt.
 *
 * - "conversational": personal assistant style, hides internal concepts,
 *   warm greetings, full projection/worker framing.
 * - "operational": focused monitoring/task style, direct language, no
 *   conversational ceremony, no sleep/wake compaction assumptions.
 */
export type PromptTone = "conversational" | "operational";

/**
 * Memory and background job configuration for an agent.
 */
export interface MemoryConfig {
  /** Run the reflection pass every 30 min (extracts projections from history). Default: true. */
  reflection: boolean;
  /** Fire the projection daily review at 08:00 UTC. Default: true. */
  daily_review: boolean;
  /**
   * Compaction strategy hint.
   * - "conversational": nightly compaction prompt says "the user is asleep"
   * - "operational": neutral compaction hint, no sleep assumptions
   */
  compaction: "conversational" | "operational";
}

/**
 * Agent definition: the portable, identity-specific configuration.
 *
 * This can come from agent.yml (new) or from the agent: section of config.yml
 * (legacy). Fields here describe what the agent IS and what it can do.
 */
export interface AgentDefinition {
  /** Which tool groups to register. Defaults to all groups. */
  tool_groups: ToolGroup[];
  /** Which system prompt sections to include. Defaults to all sections. */
  prompt_sections: PromptSection[];
  /** Prompt tone. Default: "conversational". */
  prompt_tone: PromptTone;
  /** Memory and background job config. */
  memory: MemoryConfig;
  /**
   * Additional extension .ts files to load into the agent session.
   * Absolute paths or ~ paths. Loaded in addition to the extensions
   * auto-discovered in data/files/extensions/.
   * Useful for whitelisting specific extensions from ~/.pi/agent/extensions/.
   * Paths support ${ENV_VAR} substitution.
   */
  extension_files: string[];
  /**
   * Additional SKILL.md files or skill directories to expose to the agent.
   * Absolute paths or ~ paths. Loaded in addition to the skills in data/skills/.
   * Useful for whitelisting specific skills from ~/.pi/agent/skills/.
   * Paths support ${ENV_VAR} substitution.
   */
  skill_files: string[];
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
    /** Model to use for the LLM guardrail. Defaults to the primary model.
     *  The guardrail task (ALLOW/ASK/BLOCK classification) is simple and
     *  latency-sensitive, so a smaller/cheaper model is a good fit.
     *  Format: "provider/model-id". */
    guardrail_model?: string;
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
      /** Brave Search API key. If set, used instead of SearXNG. Workers only. */
      brave_api_key?: string;
    };
    fetch_url: { timeout_ms: number };
    workers: {
      /** Maximum number of workers that may run concurrently. Default: 3. */
      max_concurrent: number;
      /** Default model for workers. Falls back to first fallback model, then primary. */
      model?: string;
      /** Named worker types with preset defaults. The agent can select a type
       *  when dispatching to get its model, tools, and timeout without
       *  specifying them individually. */
      types?: Record<string, WorkerTypeConfig>;
    };
  };
  /**
   * Optional integrations. Each entry is injected into process.env at startup
   * so extensions can read them without needing separate .env entries.
   *
   * Convention: integrations.<name>.<key> → env var NAME_KEY (uppercased, dots to underscores).
   * Example: integrations.hedgedoc.url → HEDGEDOC_URL
   */
  integrations: Record<string, Record<string, string>>;
  cron: CronJob[];
  /** Optional active hours window. Scheduler callbacks skip firing outside it. */
  active_hours?: ActiveHoursConfig;
  /** Trust and permission settings. */
  trust: {
    /** Tools pre-approved for elevated access (skip permission prompts). */
    approved_tools: string[];
  };
  /**
   * Agent definition: identity-specific config (tool groups, prompt sections,
   * tone, memory jobs). Populated from agent.yml if present, otherwise defaults
   * to the "personal-assistant" preset (all features on).
   */
  agent_def: AgentDefinition;
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
      const err = new Error(
        `Environment variable ${varName} is not set.\n` +
        `Set it in your shell, or add it to .env in your data directory.`,
      );
      (err as any).code = "CONFIG_NOT_FOUND";
      throw err;
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
 * Parse the integrations section, extracting string key-value pairs.
 *
 * Only string values are kept — nested objects, booleans, and numbers are
 * ignored. Each entry's values can use ${ENV_VAR} substitution (already
 * applied by substituteDeep before this is called).
 */
function integrationsFromConfig(substituted: Record<string, unknown>): Config["integrations"] {
  const raw = (substituted.integrations ?? {}) as Record<string, unknown>;
  const result: Record<string, Record<string, string>> = {};

  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof value === "string") {
        values[key] = value;
      }
    }
    if (Object.keys(values).length > 0) {
      result[name] = values;
    }
  }

  return result;
}

/**
 * Inject integration config values into process.env.
 * Convention: integrations.<name>.<key> becomes <NAME>_<KEY> (uppercased).
 * Existing env vars are never overwritten; .env always wins.
 */
export function applyIntegrationEnvVars(config: Config): void {
  for (const [name, values] of Object.entries(config.integrations)) {
    for (const [key, value] of Object.entries(values)) {
      const envKey = `${name}_${key}`.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      if (process.env[envKey] === undefined) {
        process.env[envKey] = value;
      }
    }
  }
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
      searxng_url: (webRaw.searxng_url as string) ?? "https://searx.be",
      brave_api_key: (webRaw.brave_api_key as string) ?? undefined,
    },
    fetch_url: {
      timeout_ms: 10000,
      ...(raw.fetch_url as object | undefined),
    },
    workers: {
      max_concurrent: 3,
      ...(raw.workers as object | undefined),
    },
  };
}

/**
 * The personal-assistant preset: all tool groups and prompt sections enabled,
 * conversational tone, reflection and daily review on. This is the default
 * for existing deployments that have no agent.yml.
 */
export const PERSONAL_ASSISTANT_DEFAULTS: AgentDefinition = {
  tool_groups: [...ALL_TOOL_GROUPS],
  prompt_sections: [...ALL_PROMPT_SECTIONS],
  prompt_tone: "conversational",
  memory: {
    reflection: true,
    daily_review: true,
    compaction: "conversational",
  },
  extension_files: [],
  skill_files: [],
};

/**
 * Parse an agent definition from a raw substituted YAML object.
 *
 * Accepts either a top-level agent.yml shape (where agent-def fields are at the
 * root) or a nested shape from config.yml (where they may appear under a future
 * "agent_def:" key). Falls back to PERSONAL_ASSISTANT_DEFAULTS for any field
 * not present in the source.
 */
function agentDefinitionFromRaw(raw: Record<string, unknown>): AgentDefinition {
  const toolGroupsRaw = raw.tool_groups ?? raw.tools;
  let tool_groups: ToolGroup[];
  if (Array.isArray(toolGroupsRaw)) {
    tool_groups = toolGroupsRaw as ToolGroup[];
  } else if (toolGroupsRaw && typeof toolGroupsRaw === "object") {
    // Support {groups: [...]} shape from agent.yml
    const groups = (toolGroupsRaw as Record<string, unknown>).groups;
    tool_groups = Array.isArray(groups) ? (groups as ToolGroup[]) : [...ALL_TOOL_GROUPS];
  } else {
    tool_groups = [...ALL_TOOL_GROUPS];
  }

  const promptRaw = raw.prompt as Record<string, unknown> | undefined;
  let prompt_sections: PromptSection[];
  if (Array.isArray(promptRaw?.sections)) {
    prompt_sections = promptRaw!.sections as PromptSection[];
  } else {
    prompt_sections = [...ALL_PROMPT_SECTIONS];
  }

  const prompt_tone: PromptTone =
    (promptRaw?.tone as PromptTone | undefined) ?? "conversational";

  const memRaw = raw.memory as Record<string, unknown> | undefined;
  const memory: MemoryConfig = {
    reflection: memRaw?.reflection !== false,
    daily_review: memRaw?.daily_review !== false,
    compaction: (memRaw?.compaction as "conversational" | "operational" | undefined) ?? "conversational",
  };

  const extension_files = Array.isArray(raw.extension_files)
    ? (raw.extension_files as string[])
    : [];

  const skill_files = Array.isArray(raw.skill_files)
    ? (raw.skill_files as string[])
    : [];

  return { tool_groups, prompt_sections, prompt_tone, memory, extension_files, skill_files };
}

/**
 * Resolve the path to an agent definition file.
 *
 * Resolution order:
 * 1. PIBOT_AGENT env var (absolute or relative to cwd)
 * 2. agent.yml in the data directory
 * 3. null (fall back to defaults embedded in config.yml)
 */
export function resolveAgentFile(dataDir: string): string | null {
  if (process.env.PIBOT_AGENT) {
    return path.resolve(process.env.PIBOT_AGENT);
  }
  const agentYml = path.join(dataDir, "agent.yml");
  if (fs.existsSync(agentYml)) {
    return agentYml;
  }
  return null;
}

/**
 * Load an agent definition file (agent.yml).
 * Returns null if the file doesn't exist or path is null.
 */
export function loadAgentDefinition(agentFilePath: string | null): AgentDefinition | null {
  if (!agentFilePath || !fs.existsSync(agentFilePath)) {
    return null;
  }
  const raw = fs.readFileSync(agentFilePath, "utf-8");
  const parsed = parseYaml(raw);
  const substituted = substituteDeep(parsed) as Record<string, unknown>;
  return agentDefinitionFromRaw(substituted);
}

/**
 * Resolve the data directory. Checked in order:
 * 1. BRYTI_DATA_DIR env var
 * 2. ./data  (development: running from the repo)
 * 3. ~/.config/bryti  (installed via npm)
 */
export function resolveDataDir(): string {
  if (process.env.BRYTI_DATA_DIR) {
    return path.resolve(process.env.BRYTI_DATA_DIR);
  }
  // If ./data/config.yml exists, we're probably in the repo
  const local = path.resolve("./data");
  if (fs.existsSync(path.join(local, "config.yml"))) {
    return local;
  }
  // XDG-style default for installed binary
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "bryti");
}

export function loadConfig(configPath?: string): Config {
  const dataDir = resolveDataDir();
  const cfgPath = configPath || path.join(dataDir, "config.yml");

  if (!fs.existsSync(cfgPath)) {
    const err = new Error(
      `Config file not found: ${cfgPath}\n` +
      `Run 'bryti hail' to set up, or set BRYTI_DATA_DIR to point to your data directory.`,
    );
    (err as any).code = "CONFIG_NOT_FOUND";
    throw err;
  }

  const raw = fs.readFileSync(cfgPath, "utf-8");
  const parsed = parseYaml(raw);
  const substituted = substituteDeep(parsed) as Record<string, unknown>;

  // Defaults
  const config: Config = {
    agent: {
      name: "Bryti",
      system_prompt: "You are a personal AI colleague. You are warm, direct, and proactive.",
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
    integrations: integrationsFromConfig(substituted),
    cron: (substituted.cron as CronJob[]) || [],
    active_hours: (substituted.active_hours as ActiveHoursConfig | undefined) ?? undefined,
    trust: {
      approved_tools: ((substituted.trust as { approved_tools?: string[] })?.approved_tools) ?? [],
    },
    // Agent definition: prefer agent.yml if present, then look for agent_def
    // in config.yml, then fall back to personal-assistant defaults.
    agent_def: (() => {
      const agentFile = resolveAgentFile(dataDir);
      const fromFile = loadAgentDefinition(agentFile);
      if (fromFile) return fromFile;
      // Legacy: agent_def key in config.yml
      if (substituted.agent_def && typeof substituted.agent_def === "object") {
        return agentDefinitionFromRaw(substituted.agent_def as Record<string, unknown>);
      }
      // Default: personal-assistant preset
      return { ...PERSONAL_ASSISTANT_DEFAULTS };
    })(),
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
 * Validate config at startup so bad config doesn't surface 30 minutes later
 * when a cron job fires.
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
    path.join(config.data_dir, "pending"),
    path.join(config.data_dir, "skills"),
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

  // Seed default extensions into the user's extensions directory.
  // Only copies when the target file does not exist.
  // An empty file signals intentional deletion by the agent — never overwrite it.
  seedDefaultExtensions(path.join(config.data_dir, "files", "extensions"));
}

/**
 * Seed default extensions into the user's extensions directory.
 *
 * Only copies when the target file doesn't exist. Never overwrites. An empty
 * file (0 bytes) is a tombstone meaning the agent intentionally deleted it;
 * never replace those either.
 */
function seedDefaultExtensions(extensionsDir: string): void {
  // In production (dist/): defaults are copied alongside the compiled output.
  // In development (src/ via ts-node or tsx): walk up to project root.
  const defaultsDir = path.join(__dirname, "defaults", "extensions");

  if (!fs.existsSync(defaultsDir)) {
    return;
  }

  for (const filename of fs.readdirSync(defaultsDir)) {
    const target = path.join(extensionsDir, filename);

    // File already exists (including empty tombstone) — leave it alone.
    if (fs.existsSync(target)) {
      continue;
    }

    const source = path.join(defaultsDir, filename);
    fs.copyFileSync(source, target);
    console.log(`[extensions] seeded default: ${filename}`);
  }
}

/**
 * Write pi settings pointing to the agent's extension directory so pi
 * discovers extensions the agent writes via file_write.
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
