/**
 * Projection reflection pass.
 *
 * A lightweight background job that scans recent conversation history and
 * extracts future references the agent missed during the live conversation.
 *
 * Design:
 * - Runs every 30 minutes via cron.
 * - Reads the JSONL audit log for the last windowMinutes of conversation.
 * - Makes a single SDK completion call (no agent loop, no tools, no session
 *   history) with a narrow extraction prompt.
 * - Uses the pi SDK's ModelRegistry + completeSimple so all providers work:
 *   Anthropic, OpenAI, OAuth tokens, etc. No raw fetch.
 * - Parses the JSON output and writes projections directly to SQLite.
 * - Tracks last-reflection timestamp per user in the same SQLite DB to
 *   avoid re-processing unchanged transcripts.
 * - Idempotent: current pending projections are included in the prompt so
 *   the model won't re-create items that are already stored.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { completeSimple } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Config } from "../config.js";
import type { ProjectionResolution, ProjectionStore } from "./store.js";
import { createProjectionStore } from "./store.js";
import { formatProjectionsForPrompt } from "./format.js";
import { toUtc } from "../time.js";
import { getUserTimezone } from "../time.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectionCandidate {
  summary: string;
  when?: string;
  resolution?: ProjectionResolution;
  context?: string;
}

export interface ArchiveCandidate {
  content: string;
}

export interface ReflectionOutput {
  project: ProjectionCandidate[];
  archive: ArchiveCandidate[];
}

export interface ReflectionResult {
  /** Number of projections written to the store. */
  projectionsAdded: number;
  /** Raw candidates extracted (before dedup). */
  candidates: ProjectionCandidate[];
  /** Whether reflection was skipped (no new messages). */
  skipped: boolean;
  /** Reason for skipping, if applicable. */
  skipReason?: string;
}

// ---------------------------------------------------------------------------
// History reading
// ---------------------------------------------------------------------------

interface HistoryEntry {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
}

/**
 * Read user+assistant messages from the JSONL audit log written in the last
 * windowMinutes minutes. Returns them in chronological order, capped at
 * maxMessages most-recent turns.
 */
export function readRecentHistory(
  historyDir: string,
  windowMinutes: number,
  maxMessages = 40,
): HistoryEntry[] {
  if (!fs.existsSync(historyDir)) return [];

  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000);
  const files = fs.readdirSync(historyDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse(); // Most recent first

  const collected: HistoryEntry[] = [];

  for (const file of files) {
    // Quick file-level date check: skip files older than cutoff date
    const fileDate = path.basename(file, ".jsonl"); // "YYYY-MM-DD"
    const fileDateObj = new Date(fileDate + "T00:00:00Z");
    // A file from yesterday may still have messages within the window
    if (fileDateObj.getTime() + 86400 * 1000 < cutoff.getTime()) {
      break; // Files are sorted newest first; nothing older will match
    }

    const filePath = path.join(historyDir, file);
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");

    for (const line of lines.reverse()) { // Newest first within file
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (entry.role !== "user" && entry.role !== "assistant") continue;
        const ts = new Date(entry.timestamp);
        if (ts < cutoff) continue;
        collected.push(entry);
        if (collected.length >= maxMessages) break;
      } catch {
        // Skip malformed lines
      }
    }
    if (collected.length >= maxMessages) break;
  }

  // Return chronological order
  return collected.reverse();
}

// ---------------------------------------------------------------------------
// Last-reflection tracking
// ---------------------------------------------------------------------------

/**
 * Read/write the last reflection timestamp from a small metadata table in
 * the user's memory.db. Returns null if never reflected.
 */
function getLastReflectionTimestamp(db: Database.Database): string | null {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflection_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const row = db.prepare("SELECT value FROM reflection_meta WHERE key = 'last_reflection'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

function setLastReflectionTimestamp(db: Database.Database, ts: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO reflection_meta (key, value) VALUES ('last_reflection', ?)",
  ).run(ts);
}

// ---------------------------------------------------------------------------
// LLM completion via pi SDK
// ---------------------------------------------------------------------------

interface CompletionMessage {
  role: "system" | "user";
  content: string;
}

/**
 * Make a single chat completion call via the pi SDK's provider layer.
 *
 * Uses ModelRegistry + AuthStorage so all providers work: Anthropic (direct
 * or OAuth), OpenAI, opencode, etc. No raw fetch, no manual API key wiring.
 *
 * The model is resolved from config.agent.reflection_model first, then
 * config.agent.model, then the first available fallback. This lets operators
 * use a cheaper model for reflection without affecting the main agent.
 */
export async function sdkComplete(
  config: Config,
  messages: CompletionMessage[],
): Promise<string> {
  const agentDir = path.join(config.data_dir, ".pi");

  // Auth: same setup as loadUserSession / workers
  const authStorage = new AuthStorage();
  for (const provider of config.models.providers) {
    if (provider.api_key) {
      authStorage.setRuntimeApiKey(provider.name, provider.api_key);
    }
  }

  // Model registry: reads the same models.json the main agent writes
  const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.json"));
  modelRegistry.refresh();

  // Resolve the model: reflection_model > primary model > first fallback
  const candidates = [
    config.agent.reflection_model,
    config.agent.model,
    ...(config.agent.fallback_models ?? []),
  ].filter(Boolean) as string[];

  let model = null;
  for (const modelString of candidates) {
    const [providerName, modelId] = modelString.includes("/")
      ? modelString.split("/", 2)
      : [modelString, modelString];

    model = modelRegistry.find(providerName, modelId);
    if (!model) {
      const available = modelRegistry.getAvailable();
      model = available.find(
        (m) => m.provider === providerName && m.id.includes(modelId),
      ) ?? null;
    }
    if (model) break;
  }

  if (!model) {
    throw new Error(
      `Reflection: no usable model found. Tried: ${candidates.join(", ")}`,
    );
  }

  // Separate system prompt from user/assistant messages
  const systemMsg = messages.find((m) => m.role === "system");
  const userMessages = messages.filter((m) => m.role !== "system");

  const context = {
    systemPrompt: systemMsg?.content,
    messages: userMessages.map((m) => ({
      role: m.role as "user",
      content: m.content,
      timestamp: Date.now(),
    })),
  };

  const apiKey = await modelRegistry.getApiKey(model);
  const result = await completeSimple(model, context, {
    maxTokens: 1024,
    temperature: 0,
    apiKey: apiKey ?? undefined,
  });

  if (result.stopReason === "error") {
    throw new Error(`Reflection LLM error: ${result.errorMessage ?? "unknown"}`);
  }

  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.type === "text" ? c.text : "")
    .join("");
}

// ---------------------------------------------------------------------------
// Reflection prompt
// ---------------------------------------------------------------------------

function buildReflectionPrompt(
  turns: HistoryEntry[],
  pendingProjections: string,
  currentDatetime: string,
): CompletionMessage[] {
  const transcript = turns
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n\n");

  const systemPrompt =
    `You are a memory assistant. Your job is to extract future commitments, ` +
    `plans, deadlines, reminders, and events from a conversation transcript.\n\n` +
    `Current datetime: ${currentDatetime}\n\n` +
    `Rules:\n` +
    `- Only extract things that are clearly about the FUTURE (from the perspective of the current datetime).\n` +
    `- Do NOT extract things already listed under "Already stored".\n` +
    `- Resolve time expressions to ISO dates or datetimes where possible.\n` +
    `- For 'when': use "YYYY-MM-DD HH:MM" for exact times, "YYYY-MM-DD" for day-resolution, ` +
    `"YYYY-Www" for week-resolution (e.g. "2026-W09"), "YYYY-MM" for month-resolution, ` +
    `or "someday" for no specific time.\n` +
    `- For 'resolution': use "exact", "day", "week", "month", or "someday".\n` +
    `- Only include items with at least a clear summary. Context is optional.\n` +
    `- If there is nothing new to extract, output: {"project":[],"archive":[]}\n` +
    `- Output valid JSON only. No commentary before or after.\n\n` +
    `Already stored as pending projections:\n${pendingProjections}`;

  const userPrompt =
    `Here is the recent conversation:\n\n${transcript}\n\n` +
    `What future events, plans, or commitments are mentioned that are NOT already stored?\n` +
    `Output JSON only:`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

/**
 * Parse the LLM output, tolerating markdown code fences and minor formatting.
 */
export function parseReflectionOutput(raw: string): ReflectionOutput {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(stripped) as Partial<ReflectionOutput>;
    return {
      project: Array.isArray(parsed.project) ? parsed.project : [],
      archive: Array.isArray(parsed.archive) ? parsed.archive : [],
    };
  } catch {
    // If the whole thing doesn't parse, return empty
    return { project: [], archive: [] };
  }
}

// ---------------------------------------------------------------------------
// Main reflection function
// ---------------------------------------------------------------------------

/**
 * Run one reflection pass for a user.
 *
 * @param config        App config (for model, data_dir, timezone).
 * @param userId        User to reflect for.
 * @param windowMinutes How far back to look in the conversation history.
 * @param store         Optional pre-opened projection store (for testing).
 * @param completeFn    Optional override for the LLM completion call (for testing).
 */
export async function runReflection(
  config: Config,
  userId: string,
  windowMinutes = 30,
  store?: ProjectionStore,
  completeFn?: typeof sdkComplete,
): Promise<ReflectionResult> {
  const historyDir = path.join(config.data_dir, "history");
  const turns = readRecentHistory(historyDir, windowMinutes);

  // Open store (or use injected one for tests)
  const ownStore = !store;
  const projStore = store ?? createProjectionStore(userId, config.data_dir);

  // Access the underlying DB for metadata tracking via the store's DB path
  const dbPath = path.join(config.data_dir, "users", userId, "memory.db");
  let metaDb: Database.Database | null = null;

  try {
    if (turns.length === 0) {
      return { projectionsAdded: 0, candidates: [], skipped: true, skipReason: "no recent messages" };
    }

    // Gate: skip if no new messages since last reflection
    metaDb = new Database(dbPath);
    const lastReflection = getLastReflectionTimestamp(metaDb);
    if (lastReflection) {
      const lastTs = new Date(lastReflection);
      const newestTurn = turns[turns.length - 1];
      if (new Date(newestTurn.timestamp) <= lastTs) {
        return { projectionsAdded: 0, candidates: [], skipped: true, skipReason: "no new messages since last reflection" };
      }
    }

    // Build prompt
    const upcoming = projStore.getUpcoming(90); // Wider window for dedup
    const pendingText = formatProjectionsForPrompt(upcoming, 30);
    const tz = getUserTimezone(config);
    const now = new Date();
    const currentDatetime = now
      .toLocaleString("sv-SE", { timeZone: tz, hour12: false })
      .slice(0, 16)
      .replace("T", " ") + (tz !== "UTC" ? ` (${tz})` : " UTC");

    const messages = buildReflectionPrompt(turns, pendingText, currentDatetime);

    // Call LLM
    const doComplete = completeFn ?? sdkComplete;
    let raw: string;
    try {
      raw = await doComplete(config, messages);
    } catch (err) {
      console.error("[reflection] LLM call failed:", (err as Error).message);
      return { projectionsAdded: 0, candidates: [], skipped: true, skipReason: `LLM error: ${(err as Error).message}` };
    }

    // Parse output
    const output = parseReflectionOutput(raw);

    // Apply projections
    const tz2 = getUserTimezone(config);
    let projectionsAdded = 0;
    for (const candidate of output.project) {
      if (!candidate.summary?.trim()) continue;
      try {
        let resolved_when: string | undefined;
        let raw_when: string | undefined;
        let resolution: ProjectionResolution = candidate.resolution ?? "day";

        if (candidate.when && candidate.when !== "someday") {
          const isoPattern = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/;
          const weekPattern = /^\d{4}-W\d{2}$/;
          const monthPattern = /^\d{4}-\d{2}$/;

          if (weekPattern.test(candidate.when)) {
            raw_when = candidate.when;
            resolution = "week";
          } else if (monthPattern.test(candidate.when)) {
            raw_when = candidate.when;
            resolution = "month";
          } else if (isoPattern.test(candidate.when)) {
            const hasTime = candidate.when.includes("T") || (candidate.when.length > 10 && candidate.when[10] === " ");
            resolved_when = hasTime ? toUtc(candidate.when, tz2) : candidate.when;
            resolution = hasTime ? "exact" : (candidate.resolution ?? "day");
          } else {
            raw_when = candidate.when;
          }
        } else if (candidate.when === "someday") {
          resolution = "someday";
        }

        projStore.add({
          summary: candidate.summary.trim(),
          raw_when,
          resolved_when,
          resolution,
          context: candidate.context,
        });
        projectionsAdded++;
      } catch (err) {
        console.warn("[reflection] Failed to store projection:", (err as Error).message, candidate);
      }
    }

    // Update last-reflection timestamp
    const reflectedAt = new Date().toISOString();
    if (metaDb) {
      setLastReflectionTimestamp(metaDb, reflectedAt);
    }

    return { projectionsAdded, candidates: output.project, skipped: false };
  } finally {
    metaDb?.close();
    if (ownStore) projStore.close();
  }
}
