/**
 * Bryti management CLI.
 *
 * Single entry point for all operator tasks. Run via:
 *   npm run cli -- <command> [options]
 *
 * Commands:
 *   help                                   Show this help text
 *   memory                                 Inspect all memory tiers
 *   memory core                            Show core memory file
 *   memory projections [--all]             Show projections (--all includes resolved)
 *   memory archival [--query <text>] [--limit <n>]  Search or list archival facts
 *   reflect [--window <minutes>]           Run the reflection pass on demand
 *   timeskip <summary> [--minutes <n>]     Move a projection's time to now+N min
 *   timeskip --list                        List all projections
 *   import-openclaw [--dry-run]            Import from /home/lars/clawd into memory
 *   fill-context [--count <n>] [--dataset <path>] [--dry-run]
 *                                          Inject synthetic conversations into history
 *                                          to fill the context window (for compaction testing)
 *   archive-fact "<content>"               Insert a fact and check trigger-based projections
 *
 * Global options:
 *   --user-id <id>     User ID (default: first allowed_users entry or BRYTI_USER_ID env)
 *   --data-dir <path>  Data directory (default: BRYTI_DATA_DIR env or ./data)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";
import { runReflection } from "./projection/index.js";

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function flag(name: string): boolean {
  return argv.includes(name);
}

function opt(name: string, fallback?: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx !== -1 ? argv[idx + 1] : fallback;
}

function positional(afterFlags: number): string | undefined {
  // Return the Nth non-flag argument
  const nonFlags = argv.filter((a) => !a.startsWith("--"));
  return nonFlags[afterFlags];
}

// ---------------------------------------------------------------------------
// Config / environment
// ---------------------------------------------------------------------------

function resolveDataDir(): string {
  return opt("--data-dir") ?? process.env.BRYTI_DATA_DIR ?? "./data";
}

function resolveUserId(dataDir: string): string {
  if (opt("--user-id")) return opt("--user-id")!;
  if (process.env.BRYTI_USER_ID) return process.env.BRYTI_USER_ID;
  // Try to read from config
  try {
    const config = loadConfig(path.join(dataDir, "config.yml"));
    const first = config.telegram.allowed_users[0];
    if (first) return String(first);
  } catch {
    // Config may not exist in dev environments
  }
  return "default-user"; // Fallback for Lars's local setup
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function hr(char = "─", width = 60): string {
  return char.repeat(width);
}

function section(title: string): void {
  console.log("\n" + hr());
  console.log(`  ${title}`);
  console.log(hr());
}

function truncate(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// ---------------------------------------------------------------------------
// Command: memory core
// ---------------------------------------------------------------------------

function cmdMemoryCore(dataDir: string): void {
  section("CORE MEMORY");
  const corePath = path.join(dataDir, "core-memory.md");
  if (!fs.existsSync(corePath)) {
    console.log("  (no core-memory.md)");
    return;
  }
  const content = fs.readFileSync(corePath, "utf-8").trim();
  console.log(content || "  (empty)");
}

// ---------------------------------------------------------------------------
// Command: memory projections
// ---------------------------------------------------------------------------

function cmdMemoryProjections(dataDir: string, userId: string, showAll: boolean): void {
  section("PROJECTIONS");

  const dbPath = path.join(dataDir, "users", userId, "memory.db");
  if (!fs.existsSync(dbPath)) {
    console.log("  (no memory.db)");
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  const where = showAll ? "" : "WHERE status = 'pending'";
  const rows = db.prepare(
    `SELECT id, summary, raw_when, resolved_when, resolution, context, status, created_at
     FROM projections ${where}
     ORDER BY
       CASE status WHEN 'pending' THEN 0 ELSE 1 END,
       CASE WHEN resolved_when IS NULL THEN 1 ELSE 0 END,
       resolved_when ASC`,
  ).all() as Array<Record<string, string>>;
  db.close();

  if (rows.length === 0) {
    console.log("  (no projections)");
    return;
  }

  const statusIcon: Record<string, string> = {
    pending: "⏳",
    done: "✅",
    cancelled: "❌",
    passed: "🔕",
  };

  for (const row of rows) {
    const icon = statusIcon[row.status] ?? "?";
    const when = row.resolved_when ?? row.raw_when ?? "someday";
    console.log(`\n${icon} ${row.summary}`);
    console.log(`   when:    ${when} [${row.resolution}]`);
    if (row.context) {
      console.log(`   context: ${truncate(row.context, 120)}`);
    }
    console.log(`   id:      ${row.id}`);
    console.log(`   created: ${row.created_at}`);
  }

  const pending = rows.filter((r) => r.status === "pending").length;
  console.log(`\n  ${pending} pending, ${rows.length} total`);
}

// ---------------------------------------------------------------------------
// Command: memory archival
// ---------------------------------------------------------------------------

function cmdMemoryArchival(dataDir: string, userId: string, query: string | undefined, limit: number): void {
  section(query ? `ARCHIVAL MEMORY — search: "${query}"` : "ARCHIVAL MEMORY (recent)");

  const dbPath = path.join(dataDir, "users", userId, "memory.db");
  if (!fs.existsSync(dbPath)) {
    console.log("  (no memory.db)");
    return;
  }

  const db = new Database(dbPath, { readonly: true });
  let rows: Array<Record<string, unknown>>;

  if (query) {
    try {
      rows = db.prepare(
        `SELECT f.id, f.content, f.source, f.timestamp
         FROM facts f
         JOIN facts_fts fts ON f.rowid = fts.rowid
         WHERE facts_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).all(query, limit) as Array<Record<string, unknown>>;
    } catch {
      rows = db.prepare(
        `SELECT id, content, source, timestamp FROM facts
         WHERE content LIKE ? ORDER BY timestamp DESC LIMIT ?`,
      ).all(`%${query}%`, limit) as Array<Record<string, unknown>>;
    }
  } else {
    rows = db.prepare(
      `SELECT id, content, source, timestamp FROM facts ORDER BY timestamp DESC LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>;
  }

  db.close();

  if (rows.length === 0) {
    console.log("  (no results)");
    return;
  }

  for (const row of rows) {
    const date = new Date(Number(row.timestamp)).toISOString().slice(0, 10);
    console.log(`\n[${date}] ${row.source}`);
    console.log(truncate(String(row.content), 300));
    console.log(`  id: ${row.id}`);
  }

  console.log(`\n  ${rows.length} result(s)`);
}

// ---------------------------------------------------------------------------
// Command: reflect
// ---------------------------------------------------------------------------

async function cmdReflect(dataDir: string, userId: string, windowMinutes: number): Promise<void> {
  console.log(`Running reflection pass (window: ${windowMinutes} min, user: ${userId})...`);

  let config;
  try {
    config = loadConfig(path.join(dataDir, "config.yml"));
  } catch (err) {
    console.error(`Failed to load config: ${(err as Error).message}`);
    process.exit(1);
  }

  // Override data_dir in case --data-dir was passed
  config.data_dir = dataDir;

  const result = await runReflection(config, userId, windowMinutes);

  if (result.skipped) {
    console.log(`Skipped: ${result.skipReason}`);
  } else if (result.projectionsAdded === 0) {
    console.log("No new projections found.");
  } else {
    console.log(`Added ${result.projectionsAdded} projection(s):`);
    for (const c of result.candidates) {
      console.log(`  + ${c.summary}${c.when ? ` [${c.when}]` : ""}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Command: timeskip
// ---------------------------------------------------------------------------

function cmdTimeskipList(dataDir: string, userId: string): void {
  const dbPath = path.join(dataDir, "users", userId, "memory.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`No memory.db found at ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT id, summary, resolved_when, resolution, status
     FROM projections ORDER BY
       CASE status WHEN 'pending' THEN 0 ELSE 1 END,
       resolved_when ASC`,
  ).all() as Array<Record<string, string>>;
  db.close();

  if (rows.length === 0) {
    console.log("No projections found.");
    return;
  }

  const statusIcon: Record<string, string> = { pending: "⏳", done: "✅", cancelled: "❌", passed: "🔕" };
  console.log("Projections:\n");
  for (const row of rows) {
    const icon = statusIcon[row.status] ?? "?";
    console.log(`${icon} [${row.resolution}] ${row.summary}`);
    console.log(`   id:   ${row.id}`);
    console.log(`   when: ${row.resolved_when ?? "(someday)"}`);
    console.log("");
  }
}

function cmdTimeskip(dataDir: string, userId: string, summaryOrId: string, minutes: number): void {
  const dbPath = path.join(dataDir, "users", userId, "memory.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`No memory.db found at ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath);

  // Detect UUID vs summary substring
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(summaryOrId);
  const row = isUuid
    ? db.prepare("SELECT * FROM projections WHERE id = ?").get(summaryOrId) as Record<string, string> | undefined
    : db.prepare("SELECT * FROM projections WHERE summary LIKE ? AND status = 'pending' LIMIT 1")
        .get(`%${summaryOrId}%`) as Record<string, string> | undefined;

  if (!row) {
    console.error(`No pending projection found matching: ${summaryOrId}`);
    db.close();
    process.exit(1);
  }

  const newTime = new Date(Date.now() + minutes * 60 * 1000);
  const newTimeStr = newTime.toISOString().slice(0, 16).replace("T", " ");

  db.prepare(
    "UPDATE projections SET resolved_when = ?, resolution = 'exact' WHERE id = ?",
  ).run(newTimeStr, row.id);
  db.close();

  console.log(`Timeskipped projection:`);
  console.log(`  Summary: ${row.summary}`);
  console.log(`  Old when: ${row.resolved_when ?? "(none)"}`);
  console.log(`  New when: ${newTimeStr} UTC (fires in ~${minutes} min)`);
  console.log(`\nThe scheduler will pick it up on the next 5-minute tick.`);
}

// ---------------------------------------------------------------------------
// Command: import-openclaw
// ---------------------------------------------------------------------------

function cmdImportOpenclaw(dataDir: string, userId: string, dryRun: boolean): void {
  const clawdDir = "/home/lars/clawd";

  console.log(`Importing OpenClaw memory into bryti`);
  console.log(`  User ID:  ${userId}`);
  console.log(`  Data dir: ${dataDir}`);
  console.log(`  Dry run:  ${dryRun}`);
  console.log("");

  // Core memory
  const userMd = path.join(clawdDir, "USER.md");
  if (!fs.existsSync(userMd)) {
    console.log("[core] USER.md not found, skipping");
  } else {
    const corePath = path.join(dataDir, "core-memory.md");
    const existing = fs.existsSync(corePath) ? fs.readFileSync(corePath, "utf-8") : "";
    if (existing.includes("## About Lars")) {
      console.log("[core] Already contains Lars profile, skipping");
    } else {
      const userContent = fs.readFileSync(userMd, "utf-8");
      const sectionText = "\n\n## About Lars\n" + userContent.replace(/^# USER\.md.*\n/, "").trim();
      if (dryRun) {
        console.log("[core] DRY RUN — would append to core-memory.md:");
        console.log(sectionText.slice(0, 300) + "...");
      } else {
        fs.appendFileSync(corePath, sectionText, "utf-8");
        console.log(`[core] Appended USER.md to core-memory.md (${sectionText.length} chars)`);
      }
    }
  }

  // Archival memory
  const memoryDir = path.join(clawdDir, "memory");
  if (!fs.existsSync(memoryDir)) {
    console.log("[archival] memory/ directory not found, skipping");
    console.log("\nDone.");
    return;
  }

  const files = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md")).sort();
  console.log(`[archival] Found ${files.length} memory files`);

  if (dryRun) {
    for (const file of files) {
      const content = fs.readFileSync(path.join(memoryDir, file), "utf-8");
      const sections = splitIntoSections(content, file);
      console.log(`[archival] DRY RUN — ${file}: ${sections.length} section(s)`);
    }
    console.log("\nDone (dry run).");
    return;
  }

  const userDir = path.join(dataDir, "users", userId);
  fs.mkdirSync(userDir, { recursive: true });

  const db = new Database(path.join(userDir, "memory.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL,
      timestamp INTEGER NOT NULL, hash TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(content, content='facts', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;
  `);

  const insertStmt = db.prepare(
    "INSERT OR IGNORE INTO facts (id, content, source, timestamp, hash) VALUES (?, ?, ?, ?, ?)",
  );
  const existsStmt = db.prepare("SELECT hash FROM facts WHERE hash = ?");

  let inserted = 0;
  let skipped = 0;

  for (const file of files) {
    const filePath = path.join(memoryDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const sections = splitIntoSections(content, file);
    const timestamp = fs.statSync(filePath).mtimeMs;

    for (const sec of sections) {
      const hash = crypto.createHash("sha256").update(sec).digest("hex").slice(0, 16);
      if (existsStmt.get(hash)) {
        skipped++;
        continue;
      }
      insertStmt.run(crypto.randomUUID(), sec, `openclaw:memory/${file}`, timestamp, hash);
      inserted++;
    }

    console.log(`[archival] ${file}: ${sections.length} section(s)`);
  }

  db.close();
  console.log(`[archival] Done: ${inserted} inserted, ${skipped} skipped`);
  console.log("\nDone. Restart bryti for core memory changes to take effect.");
}

function splitIntoSections(content: string, filename: string): string[] {
  const date = path.basename(filename, ".md");
  const parts = content.split(/^## /m);
  const sections: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.length < 50) continue;
    sections.push(`[${date}] ## ${trimmed}`);
  }
  if (sections.length === 0 && content.trim().length > 50) {
    sections.push(`[${date}] ${content.trim()}`);
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Command: fill-context
// ---------------------------------------------------------------------------

const DEFAULT_DATASET = path.join(
  "/home/lars/xithing/contextpatterns-content/synthetic-agent-conversations",
  "dataset/memory-context.jsonl",
);

interface SyntheticTurn {
  role: "user" | "assistant";
  content: string;
  tool_calls?: unknown[];
}

interface SyntheticConversation {
  id: string;
  subcategory: string;
  description: string;
  turns: SyntheticTurn[];
}

/**
 * Inject synthetic conversations into the history JSONL log.
 *
 * Writes entries back-dated by a configurable offset so they appear as
 * real history to the reflection pass and the agent's context loader.
 * Prioritises context-window-pressure subcategory conversations.
 */
function cmdFillContext(
  dataDir: string,
  count: number,
  datasetPath: string,
  dryRun: boolean,
): void {
  if (!fs.existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(datasetPath, "utf-8").split("\n").filter(Boolean);
  const all: SyntheticConversation[] = lines.map((l) => JSON.parse(l));

  // Prefer context-window-pressure, then fall back to all
  const pressure = all.filter((c) => c.subcategory === "context-window-pressure");
  const pool = pressure.length >= count ? pressure : all;
  const selected = pool.slice(0, count);

  // Count total turns we'll inject
  const totalTurns = selected.reduce((n, c) => n + c.turns.filter((t) => t.role === "user" || t.role === "assistant").length, 0);
  console.log(`Injecting ${selected.length} conversation(s), ${totalTurns} turns total`);
  if (dryRun) console.log("(dry run — nothing will be written)\n");

  // Back-date entries starting from 2 hours ago, spreading turns across time
  const now = Date.now();
  const startMs = now - 2 * 60 * 60 * 1000;
  const stepMs = Math.floor((2 * 60 * 60 * 1000) / Math.max(totalTurns, 1));

  const historyDir = path.join(dataDir, "history");
  if (!dryRun) fs.mkdirSync(historyDir, { recursive: true });

  let turnIdx = 0;
  const byDay = new Map<string, string[]>();

  for (const conv of selected) {
    console.log(`  [${conv.id}] ${conv.description}`);

    for (const turn of conv.turns) {
      if (turn.role !== "user" && turn.role !== "assistant") continue;

      const ts = new Date(startMs + turnIdx * stepMs);
      const day = ts.toISOString().slice(0, 10);
      const entry = JSON.stringify({
        role: turn.role,
        content: turn.content,
        timestamp: ts.toISOString(),
        _synthetic: true,
      });

      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(entry);
      turnIdx++;
    }
  }

  if (!dryRun) {
    for (const [day, entries] of byDay) {
      const filePath = path.join(historyDir, `${day}.jsonl`);
      fs.appendFileSync(filePath, entries.join("\n") + "\n", "utf-8");
      console.log(`  Written ${entries.length} entries to history/${day}.jsonl`);
    }
    console.log(`\nDone. Restart bryti to pick up the new history in context.`);
  } else {
    for (const [day, entries] of byDay) {
      console.log(`  Would write ${entries.length} entries to history/${day}.jsonl`);
    }
    console.log("\nDone (dry run).");
  }
}

// ---------------------------------------------------------------------------
// Command: archive-fact
// ---------------------------------------------------------------------------

async function cmdArchiveFact(dataDir: string, userId: string, content: string): Promise<void> {
  console.log(`Archiving fact for user ${userId}...`);
  console.log(`Content: "${content}"\n`);

  // Lazy-import heavy modules only when this command is used.
  const { embed } = await import("./memory/embeddings.js");
  const { createMemoryStore } = await import("./memory/store.js");
  const { createProjectionStore } = await import("./projection/index.js");

  const modelsDir = path.join(dataDir, ".models");
  const memoryStore = createMemoryStore(userId, dataDir);
  const projStore = createProjectionStore(userId, dataDir);

  try {
    // Embed and store the fact.
    const embedding = await embed(content, modelsDir);
    memoryStore.addFact(content, "cli", embedding);
    console.log("Fact archived.");

    // Check triggers (keyword + embedding fallback).
    const triggered = await projStore.checkTriggers(
      content,
      (text) => embed(text, modelsDir),
    );

    if (triggered.length > 0) {
      console.log(`\nTriggered ${triggered.length} projection(s):`);
      for (const p of triggered) {
        console.log(`  ✅ ${p.summary} (id: ${p.id})`);
      }
      console.log("\nThese projections are now active (resolution=exact, resolved_when=now).");
      console.log("The scheduler will fire them on the next 5-minute tick.");
    } else {
      console.log("\nNo triggers matched.");
    }
  } finally {
    memoryStore.close();
    projStore.close();
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
bryti CLI — management commands

Usage:
  npm run cli -- <command> [options]

Commands:
  help
    Show this help text.

  memory
    Inspect all memory tiers (core + projections + archival).

  memory core
    Show the core memory file.

  memory projections [--all]
    Show pending projections. Pass --all to include resolved ones.

  memory archival [--query <text>] [--limit <n>]
    Show recent archival facts, or search by keyword.
    Default limit: 20.

  reflect [--window <minutes>]
    Run the reflection pass on demand. Scans recent conversation history
    for future references the agent may have missed.
    Default window: 30 minutes.

  timeskip <summary|id> [--minutes <n>]
    Move a projection's resolved_when to now + N minutes so the
    exact-time scheduler fires it on the next 5-minute tick.
    Matches by summary substring or exact UUID.
    Default: 2 minutes.

  timeskip --list
    List all projections with their IDs and times.

  import-openclaw [--dry-run]
    Import /home/lars/clawd/USER.md into core memory and
    /home/lars/clawd/memory/*.md into archival memory.

  fill-context [--count <n>] [--dataset <path>] [--dry-run]
    Inject synthetic conversations into history to fill the context window.
    Used to test compaction and archival memory retrieval under context pressure.
    Prioritises context-window-pressure conversations from the dataset.
    Default count: 10. Default dataset: synthetic-agent-conversations/dataset/memory-context.jsonl

  archive-fact "<content>"
    Insert a fact into archival memory and check if any trigger-based
    projections fire. Uses keyword matching + embedding similarity fallback.
    Useful for testing trigger_on_fact without going through the agent.

Global options:
  --user-id <id>     User ID (default: first entry in telegram.allowed_users)
  --data-dir <path>  Data directory (default: BRYTI_DATA_DIR env or ./data)
`);
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const command = positional(0);

  if (!command || command === "help" || flag("--help") || flag("-h")) {
    showHelp();
    return;
  }

  const dataDir = resolveDataDir();
  const userId = resolveUserId(dataDir);

  switch (command) {
    case "memory": {
      const sub = positional(1);
      const showAll = flag("--all");
      const query = opt("--query");
      const limit = Number(opt("--limit", "20"));

      if (!sub || sub === "all") {
        cmdMemoryCore(dataDir);
        cmdMemoryProjections(dataDir, userId, showAll);
        cmdMemoryArchival(dataDir, userId, query, limit);
      } else if (sub === "core") {
        cmdMemoryCore(dataDir);
      } else if (sub === "projections") {
        cmdMemoryProjections(dataDir, userId, showAll);
      } else if (sub === "archival") {
        cmdMemoryArchival(dataDir, userId, query, limit);
      } else {
        console.error(`Unknown memory subcommand: ${sub}`);
        console.error("Use: memory [core|projections|archival|all]");
        process.exit(1);
      }
      break;
    }

    case "reflect": {
      const window = Number(opt("--window", "30"));
      await cmdReflect(dataDir, userId, window);
      break;
    }

    case "timeskip": {
      if (flag("--list")) {
        cmdTimeskipList(dataDir, userId);
        break;
      }
      const summaryOrId = positional(1);
      if (!summaryOrId) {
        console.error("Usage: timeskip <summary|id> [--minutes <n>] | timeskip --list");
        process.exit(1);
      }
      const minutes = Number(opt("--minutes", "2"));
      cmdTimeskip(dataDir, userId, summaryOrId, minutes);
      break;
    }

    case "import-openclaw": {
      cmdImportOpenclaw(dataDir, userId, flag("--dry-run"));
      break;
    }

    case "fill-context": {
      const count = Number(opt("--count", "10"));
      const dataset = opt("--dataset", DEFAULT_DATASET)!;
      cmdFillContext(dataDir, count, dataset, flag("--dry-run"));
      break;
    }

    case "archive-fact": {
      const content = positional(1);
      if (!content) {
        console.error('Usage: archive-fact "<content>"');
        process.exit(1);
      }
      await cmdArchiveFact(dataDir, userId, content);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'npm run cli -- help' for usage.");
      process.exit(1);
  }

  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", (err as Error).message);
  process.exit(1);
});
