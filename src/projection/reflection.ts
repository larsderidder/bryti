/**
 * Projection reflection pass.
 *
 * Lightweight background job that scans recent conversation history for
 * future references the agent missed during live chat.
 *
 * Runs every 30 min via cron. Reads the JSONL audit log, makes a single
 * completeSimple() call with a narrow extraction prompt (no agent loop,
 * no tools), parses the JSON output, and writes projections directly to
 * SQLite. Existing pending projections are included in the prompt so the
 * model won't duplicate them. A per-user timestamp tracks the last run
 * to skip unchanged transcripts.
 *
 * Why completeSimple() instead of a full agent loop?
 * The reflection pass has no side effects and requires no tool calls. It only
 * needs one prompt in and one JSON blob out. Using a full agent loop would add
 * latency, cost, and the risk of unintended tool invocations. completeSimple()
 * is cheaper, faster, and keeps the pass strictly read-only from the model's
 * perspective.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Config } from "../config.js";
import type { ProjectionResolution, ProjectionStore } from "./store.js";
import { createProjectionStore } from "./store.js";
import { formatProjectionsForPrompt } from "./format.js";
import { toUtc, getUserTimezone } from "../time.js";
import { createModelInfra, resolveFirstModel } from "../model-infra.js";

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
  /**
   * TODO: archive candidates are extracted from the LLM output but are not
   * currently written anywhere. This field is a placeholder for a future
   * feature that would auto-insert noteworthy facts into archival memory
   * during the reflection pass.
   */
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
 * Read user+assistant messages from the JSONL audit log for the last
 * `windowMinutes`. Returns entries in chronological order, capped at
 * `maxMessages`.
 *
 * Reads from the JSONL audit log written by src/compaction/history.ts, NOT
 * from the pi SDK session file. The audit log is the only way to get
 * structured turn-by-turn history outside of a live session context: the pi
 * session file is append-only and interleaved with tool scaffolding, whereas
 * the audit log contains clean role/content/timestamp records per message.
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
 * Read/write the last reflection timestamp from a metadata table in memory.db.
 *
 * The timestamp is used to skip reflection when there are no new messages
 * since the last run: if the newest audit-log entry is not newer than the
 * stored timestamp, the pass exits early without calling the LLM. This keeps
 * cron overhead negligible for idle users.
 *
 * The timestamp is stored in the same SQLite database as archival memory
 * (memory.db), so it survives process restarts. A plain text file was
 * considered but SQLite gives atomic writes for free.
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
 * Single chat completion via the pi SDK provider layer. Uses reflection_model
 * if configured, otherwise falls back to the primary model and then the
 * fallback chain. This lets operators use a cheaper model for reflection.
 */
export async function sdkComplete(
  config: Config,
  messages: CompletionMessage[],
): Promise<string> {
  const { modelRegistry } = createModelInfra(config);

  // Resolve the model: reflection_model > primary model > first fallback
  const candidates = [
    config.agent.reflection_model,
    config.agent.model,
    ...(config.agent.fallback_models ?? []),
  ].filter(Boolean) as string[];

  const model = resolveFirstModel(candidates, modelRegistry);
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
 *
 * Even with `temperature: 0` and an explicit "output JSON only" instruction,
 * models occasionally wrap their response in a ```json ... ``` code fence.
 * The stripping step removes those fences before calling JSON.parse(), so
 * both bare JSON and fenced JSON are accepted.
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
 * Run one reflection pass for a user. Reads recent conversation, extracts
 * future references via LLM, and writes new projections to the store.
 */
export async function runReflection(
  config: Config,
  userId: string,
  windowMinutes = 30,
  store?: ProjectionStore,
  completeFn?: typeof sdkComplete,
): Promise<ReflectionResult> {
  // Step 1: Read history from the JSONL audit log.
  const historyDir = path.join(config.data_dir, "history");
  const turns = readRecentHistory(historyDir, windowMinutes);

  // Open store (or use injected one for tests)
  const ownStore = !store;
  const projStore = store ?? createProjectionStore(userId, config.data_dir);

  // Access the underlying DB for metadata tracking via the store's DB path
  const dbPath = path.join(config.data_dir, "users", userId, "memory.db");
  let metaDb: Database.Database | null = null;

  try {
    // Step 2: Check for new messages. Skip the LLM call entirely if there is
    // nothing to process: no turns in the window, or no turns newer than the
    // last reflection timestamp.
    if (turns.length === 0) {
      return { projectionsAdded: 0, candidates: [], skipped: true, skipReason: "no recent messages" };
    }

    metaDb = new Database(dbPath);
    const lastReflection = getLastReflectionTimestamp(metaDb);
    if (lastReflection) {
      const lastTs = new Date(lastReflection);
      const newestTurn = turns[turns.length - 1];
      if (new Date(newestTurn.timestamp) <= lastTs) {
        return { projectionsAdded: 0, candidates: [], skipped: true, skipReason: "no new messages since last reflection" };
      }
    }

    // Step 3: Load existing pending projections so the model can skip them.
    // A 90-day window is used here (wider than the history window) to give the
    // deduplication step the best chance of catching near-duplicates.
    const upcoming = projStore.getUpcoming(90);
    const pendingText = formatProjectionsForPrompt(upcoming, 30);
    const tz = getUserTimezone(config);
    const now = new Date();
    const currentDatetime = now
      .toLocaleString("sv-SE", { timeZone: tz, hour12: false })
      .slice(0, 16)
      .replace("T", " ") + (tz !== "UTC" ? ` (${tz})` : " UTC");

    const messages = buildReflectionPrompt(turns, pendingText, currentDatetime);

    // Step 4: Call the LLM. One prompt in, one JSON blob out — no tool calls.
    const doComplete = completeFn ?? sdkComplete;
    let raw: string;
    try {
      raw = await doComplete(config, messages);
    } catch (err) {
      console.error("[reflection] LLM call failed:", (err as Error).message);
      return { projectionsAdded: 0, candidates: [], skipped: true, skipReason: `LLM error: ${(err as Error).message}` };
    }

    // Step 5: Parse JSON from the raw LLM output.
    const output = parseReflectionOutput(raw);

    // Step 6: Deduplicate against existing projections and write survivors.
    // Deduplication is prompt-based: the existing pending projections were
    // included in the system prompt under "Already stored", and the model is
    // instructed not to re-extract them. This is approximate — the model may
    // still emit a candidate whose summary is a paraphrase of an existing one.
    // A secondary code-level check (substring match on summaries) would reduce
    // false duplicates but is not currently implemented.
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
