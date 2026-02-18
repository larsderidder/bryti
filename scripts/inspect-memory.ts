/**
 * Inspect pibot memory state: core memory, projections, and archival facts.
 *
 * Usage:
 *   npx tsx scripts/inspect-memory.ts [command] [options]
 *
 * Commands:
 *   core                      Show core memory file
 *   projections [--all]       Show pending projections (--all includes resolved)
 *   archival [--query <text>] Show recent archival facts, or search by query
 *   all                       Show everything (default)
 *
 * Options:
 *   --user-id <id>            User ID (default: default-user)
 *   --limit <n>               Max facts to show (default: 20)
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const PIBOT_DATA_DIR = process.env.PIBOT_DATA_DIR ?? "./data";
const USER_ID = process.argv.includes("--user-id")
  ? process.argv[process.argv.indexOf("--user-id") + 1]
  : "default-user";
const LIMIT = process.argv.includes("--limit")
  ? Number(process.argv[process.argv.indexOf("--limit") + 1])
  : 20;
const QUERY = process.argv.includes("--query")
  ? process.argv[process.argv.indexOf("--query") + 1]
  : undefined;
const SHOW_ALL = process.argv.includes("--all");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const command = args[0] ?? "all";

// ---------------------------------------------------------------------------
// Helpers
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
// Core memory
// ---------------------------------------------------------------------------

function showCore(): void {
  section("CORE MEMORY");
  const corePath = path.join(PIBOT_DATA_DIR, "core-memory.md");
  if (!fs.existsSync(corePath)) {
    console.log("  (no core-memory.md)");
    return;
  }
  const content = fs.readFileSync(corePath, "utf-8").trim();
  if (!content) {
    console.log("  (empty)");
    return;
  }
  console.log(content);
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function showProjections(): void {
  section("PROJECTIONS");

  const dbPath = path.join(PIBOT_DATA_DIR, "users", USER_ID, "memory.db");
  if (!fs.existsSync(dbPath)) {
    console.log("  (no memory.db)");
    return;
  }

  const db = new Database(dbPath, { readonly: true });

  const where = SHOW_ALL ? "" : "WHERE status = 'pending'";
  const rows = db.prepare(
    `SELECT id, summary, raw_when, resolved_when, resolution, context, status, created_at
     FROM projections ${where}
     ORDER BY
       CASE status WHEN 'pending' THEN 0 ELSE 1 END,
       CASE WHEN resolved_when IS NULL THEN 1 ELSE 0 END,
       resolved_when ASC`,
  ).all() as any[];

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
    console.log(`   when:       ${when} [${row.resolution}]`);
    if (row.context) {
      console.log(`   context:    ${truncate(row.context, 120)}`);
    } else {
      console.log(`   context:    (empty)`);
    }
    console.log(`   id:         ${row.id}`);
    console.log(`   created:    ${row.created_at}`);
  }

  const pending = rows.filter((r) => r.status === "pending").length;
  console.log(`\n  ${pending} pending, ${rows.length} total`);
}

// ---------------------------------------------------------------------------
// Archival memory
// ---------------------------------------------------------------------------

function showArchival(): void {
  section(QUERY ? `ARCHIVAL MEMORY — search: "${QUERY}"` : "ARCHIVAL MEMORY (recent)");

  const dbPath = path.join(PIBOT_DATA_DIR, "users", USER_ID, "memory.db");
  if (!fs.existsSync(dbPath)) {
    console.log("  (no memory.db)");
    return;
  }

  const db = new Database(dbPath, { readonly: true });

  let rows: any[];
  if (QUERY) {
    // FTS5 search
    try {
      rows = db.prepare(
        `SELECT f.id, f.content, f.source, f.timestamp
         FROM facts f
         JOIN facts_fts fts ON f.rowid = fts.rowid
         WHERE facts_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).all(QUERY, LIMIT);
    } catch {
      // Fallback to LIKE if FTS fails
      rows = db.prepare(
        `SELECT id, content, source, timestamp FROM facts
         WHERE content LIKE ?
         ORDER BY timestamp DESC LIMIT ?`,
      ).all(`%${QUERY}%`, LIMIT);
    }
  } else {
    rows = db.prepare(
      `SELECT id, content, source, timestamp FROM facts
       ORDER BY timestamp DESC LIMIT ?`,
    ).all(LIMIT);
  }

  db.close();

  if (rows.length === 0) {
    console.log("  (no results)");
    return;
  }

  for (const row of rows) {
    const date = new Date(row.timestamp).toISOString().slice(0, 10);
    console.log(`\n[${date}] ${row.source}`);
    console.log(truncate(row.content, 300));
    console.log(`  id: ${row.id}`);
  }

  console.log(`\n  ${rows.length} result(s)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

switch (command) {
  case "core":
    showCore();
    break;
  case "projections":
    showProjections();
    break;
  case "archival":
    showArchival();
    break;
  case "all":
    showCore();
    showProjections();
    showArchival();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: inspect-memory.ts [core|projections|archival|all] [--all] [--query <text>] [--limit <n>]");
    process.exit(1);
}

console.log("");
