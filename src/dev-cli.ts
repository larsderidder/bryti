#!/usr/bin/env node
/**
 * Bryti development CLI. Debug and testing commands that are NOT shipped
 * with the npm package. Run via: npm run dev-cli -- <command>
 */

// Load .env if present
try { process.loadEnvFile(".env"); } catch { /* not present, fine */ }

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { loadConfig } from "./config.js";

const argv = process.argv.slice(2);

function flag(name: string): boolean {
  return argv.includes(name);
}

function opt(name: string, fallback?: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx !== -1 ? argv[idx + 1] : fallback;
}

function positional(afterFlags: number): string | undefined {
  const nonFlags = argv.filter((a) => !a.startsWith("--"));
  return nonFlags[afterFlags];
}

function resolveDataDir(): string {
  return opt("--data-dir") ?? process.env.BRYTI_DATA_DIR ?? "./data";
}

function resolveUserId(dataDir: string): string {
  const explicit = opt("--user-id") ?? process.env.BRYTI_USER_ID;
  if (explicit) return explicit;
  try {
    const config = loadConfig(path.join(dataDir, "config.yml"));
    const first = config.telegram.allowed_users[0];
    if (first) return String(first);
  } catch {
    // Config may not exist
  }
  return "default";
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

function cmdImportOpenclaw(dataDir: string, userId: string, dryRun: boolean): void {
  const clawdDir = opt("--source") ?? "/home/lars/clawd";

  console.log(`Importing OpenClaw memory into bryti`);
  console.log(`  Source:   ${clawdDir}`);
  console.log(`  User ID:  ${userId}`);
  console.log(`  Data dir: ${dataDir}`);
  console.log(`  Dry run:  ${dryRun}`);
  console.log("");

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

// ---------------------------------------------------------------------------
// Command: fill-context
// ---------------------------------------------------------------------------

const DEFAULT_DATASET = "synthetic-agent-conversations/dataset/memory-context.jsonl";

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

  const pressure = all.filter((c) => c.subcategory === "context-window-pressure");
  const pool = pressure.length >= count ? pressure : all;
  const selected = pool.slice(0, count);

  const totalTurns = selected.reduce((n, c) => n + c.turns.filter((t) => t.role === "user" || t.role === "assistant").length, 0);
  console.log(`Injecting ${selected.length} conversation(s), ${totalTurns} turns total`);
  if (dryRun) console.log("(dry run — nothing will be written)\n");

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
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
bryti dev — development and testing commands (not shipped)

Usage:
  npm run dev-cli -- <command> [options]

Commands:
  timeskip <summary|id> [--minutes <n>]
    Move a projection's resolved_when to now + N minutes.
    Default: 2 minutes.

  timeskip --list
    List all projections with their IDs and times.

  import-openclaw [--source <path>] [--dry-run]
    Import OpenClaw memory files into bryti archival memory.
    Default source: /home/lars/clawd

  fill-context [--count <n>] [--dataset <path>] [--dry-run]
    Inject synthetic conversations into history for testing.
    Default count: 10.

Global options:
  --user-id <id>     User ID (default: first in telegram.allowed_users)
  --data-dir <path>  Data directory (default: BRYTI_DATA_DIR env or ./data)
`);
}

// ---------------------------------------------------------------------------
// Main
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

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'npm run dev-cli -- help' for usage.");
      process.exit(1);
  }

  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", (err as Error).message);
  process.exit(1);
});
