#!/usr/bin/env node
// Load .env if present (needed when running as an installed npm binary)
try { process.loadEnvFile(".env"); } catch { /* not present, fine */ }

/**
 * Bryti CLI. Starts the server or runs management commands.
 *
 * `bryti` (no args) or `bryti serve` starts the server.
 * `bryti <command>` runs a management command. Management commands bypass
 * the running application and read/write SQLite directly (safe to run
 * while the server is running, thanks to WAL mode).
 *
 * See `bryti help` for full command listing.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadConfig, resolveDataDir as defaultDataDir } from "./config.js";
import { runReflection } from "./projection/index.js";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version as string;

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
  const nonFlags = argv.filter((a) => !a.startsWith("--"));
  return nonFlags[afterFlags];
}

// ---------------------------------------------------------------------------
// Config / environment
// ---------------------------------------------------------------------------

function resolveDataDir(): string {
  return opt("--data-dir") ?? defaultDataDir();
}

function resolveUserId(_dataDir: string): string {
  if (opt("--user-id")) return opt("--user-id")!;
  if (process.env.BRYTI_USER_ID) return process.env.BRYTI_USER_ID;
  try {
    const config = loadConfig();
    const first = config.telegram.allowed_users[0];
    if (first) return String(first);
  } catch {
    // Config may not exist yet
  }
  return "default-user";
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
// Command: archive-fact
// ---------------------------------------------------------------------------

async function cmdArchiveFact(dataDir: string, userId: string, content: string): Promise<void> {
  console.log(`Archiving fact for user ${userId}...`);
  console.log(`Content: "${content}"\n`);

  const { embed } = await import("./memory/embeddings.js");
  const { createMemoryStore } = await import("./memory/store.js");
  const { createProjectionStore } = await import("./projection/index.js");

  const modelsDir = path.join(dataDir, ".models");
  const memoryStore = createMemoryStore(userId, dataDir);
  const projStore = createProjectionStore(userId, dataDir);

  try {
    const embedding = await embed(content, modelsDir);
    memoryStore.addFact(content, "cli", embedding);
    console.log("Fact archived.");

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
// Command: init
// ---------------------------------------------------------------------------

function cmdInit(target: string): void {
  const resolved = path.resolve(target);

  if (fs.existsSync(path.join(resolved, "config.yml"))) {
    console.log(`Already initialized: ${resolved}/config.yml exists.`);
    return;
  }

  fs.mkdirSync(resolved, { recursive: true });

  // Copy config.example.yml from the package
  const pkgRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
  const exampleSrc = path.join(pkgRoot, "config.example.yml");

  if (fs.existsSync(exampleSrc)) {
    fs.copyFileSync(exampleSrc, path.join(resolved, "config.yml"));
  } else {
    // Fallback: create a minimal config
    fs.writeFileSync(path.join(resolved, "config.yml"), [
      "# Bryti configuration. See https://github.com/larsderidder/bryti",
      "agent:",
      "  name: Bryti",
      "  model: anthropic/claude-sonnet-4-6",
      "",
      "telegram:",
      "  token: ${TELEGRAM_BOT_TOKEN}",
      "  allowed_users: []",
      "",
      "models:",
      "  providers:",
      "    - name: anthropic",
      "      api: anthropic",
      "      api_key: ${ANTHROPIC_API_KEY}",
      "      models:",
      "        - id: claude-sonnet-4-6",
      "",
    ].join("\n"), "utf-8");
  }

  // Copy default extensions
  const defaultExtDir = path.join(pkgRoot, "defaults", "extensions");
  const extDir = path.join(resolved, "files", "extensions");
  if (fs.existsSync(defaultExtDir)) {
    fs.mkdirSync(extDir, { recursive: true });
    for (const file of fs.readdirSync(defaultExtDir)) {
      fs.copyFileSync(path.join(defaultExtDir, file), path.join(extDir, file));
    }
  }

  console.log(`Initialized bryti data directory: ${resolved}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Edit ${resolved}/config.yml`);
  console.log(`  2. Set your Telegram bot token and API keys`);
  console.log(`  3. Run: bryti serve`);

  if (resolved !== path.resolve("./data")) {
    console.log(`\n  Tip: set BRYTI_DATA_DIR=${resolved} so bryti finds it.`);
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  const dataDir = resolveDataDir();
  console.log(`
bryti ${VERSION} — AI colleague in your messaging apps

Usage:
  bryti                Start the server (Telegram/WhatsApp bridges, scheduler)
  bryti serve          Same as above (explicit)
  bryti <command>      Run a management command (safe while server is running)

Commands:
  init [<path>]
    Create a new bryti data directory with config.example.yml.
    Default path: ${dataDir}

  serve
    Start the bryti server.

  memory [core|projections|archival|all]
    Inspect memory tiers. No subcommand shows all tiers.

  memory projections [--all]
    Show pending projections. --all includes resolved ones.

  memory archival [--query <text>] [--limit <n>]
    Show recent archival facts, or search by keyword. Default limit: 20.

  reflect [--window <minutes>]
    Run the reflection pass on demand. Default window: 30 minutes.

  archive-fact "<content>"
    Insert a fact into archival memory and check trigger-based projections.

  version
    Show version number.

  help
    Show this help text.

Global options:
  --user-id <id>     User ID (default: first entry in telegram.allowed_users)
  --data-dir <path>  Data directory (default: ${dataDir})
`);
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Flags that work without a command
  if (flag("--version") || flag("-v")) {
    console.log(VERSION);
    return;
  }

  if (flag("--help") || flag("-h")) {
    showHelp();
    return;
  }

  const command = positional(0);

  // No args or "serve": start the server
  if (!command || command === "serve") {
    const { startServer } = await import("./index.js");
    await startServer();
    return;
  }

  if (command === "version") {
    console.log(VERSION);
    return;
  }

  if (command === "help") {
    showHelp();
    return;
  }

  if (command === "init") {
    const target = positional(1) ?? resolveDataDir();
    cmdInit(target);
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
      console.error("Run 'bryti help' for usage.");
      process.exit(1);
  }

  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", (err as Error).message);
  process.exit(1);
});
