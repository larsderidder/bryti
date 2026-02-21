/**
 * Import OpenClaw memory into bryti's memory system.
 *
 * Sources:
 * - /home/lars/clawd/USER.md    → appended to core memory (always in context)
 * - /home/lars/clawd/memory/*.md → archival memory (searchable on demand)
 *
 * Run once:
 *   npx tsx scripts/import-openclaw-memory.ts [--user-id default-user] [--dry-run]
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CLAWD_DIR = "/home/lars/clawd";
const BRYTI_DATA_DIR = process.env.BRYTI_DATA_DIR ?? "./data";
const USER_ID = process.argv.includes("--user-id")
  ? process.argv[process.argv.indexOf("--user-id") + 1]
  : "default-user";
const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Core memory import
// ---------------------------------------------------------------------------

function importCoreMemory(): void {
  const userMd = path.join(CLAWD_DIR, "USER.md");
  if (!fs.existsSync(userMd)) {
    console.log("[core] USER.md not found, skipping");
    return;
  }

  const corePath = path.join(BRYTI_DATA_DIR, "core-memory.md");
  const existing = fs.existsSync(corePath) ? fs.readFileSync(corePath, "utf-8") : "";

  if (existing.includes("## About Lars")) {
    console.log("[core] Already contains Lars profile, skipping");
    return;
  }

  const userContent = fs.readFileSync(userMd, "utf-8");

  // Strip the heading and reformat as a section
  const section = "\n\n## About Lars\n" + userContent.replace(/^# USER\.md.*\n/, "").trim();

  if (DRY_RUN) {
    console.log("[core] DRY RUN — would append to core-memory.md:");
    console.log(section.slice(0, 300) + "...");
    return;
  }

  fs.appendFileSync(corePath, section, "utf-8");
  console.log(`[core] Appended USER.md to core-memory.md (${section.length} chars)`);
}

// ---------------------------------------------------------------------------
// Archival memory import
// ---------------------------------------------------------------------------

interface InsertStmt {
  run: (id: string, content: string, source: string, timestamp: number, hash: string) => void;
}

interface ExistsStmt {
  get: (hash: string) => { hash: string } | undefined;
}

function openDb(): { insert: InsertStmt; exists: ExistsStmt; close: () => void } {
  const userDir = path.join(BRYTI_DATA_DIR, "users", USER_ID);
  fs.mkdirSync(userDir, { recursive: true });

  const db = new Database(path.join(userDir, "memory.db"));
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id        TEXT PRIMARY KEY,
      content   TEXT NOT NULL,
      source    TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      hash      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS facts_fts (
      content TEXT
    );
  `);

  const insert = db.prepare(
    "INSERT OR IGNORE INTO facts (id, content, source, timestamp, hash) VALUES (?, ?, ?, ?, ?)",
  );
  const exists = db.prepare("SELECT hash FROM facts WHERE hash = ?");

  return {
    insert: insert as unknown as InsertStmt,
    exists: exists as unknown as ExistsStmt,
    close: () => db.close(),
  };
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Split a memory file into sections by ## heading.
 * Each section becomes a separate archival fact.
 */
function splitIntoSections(content: string, filename: string): string[] {
  const date = path.basename(filename, ".md");
  const sections: string[] = [];

  // Split on ## headings
  const parts = content.split(/^## /m);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.length < 50) continue; // Skip tiny fragments

    // Prepend date context
    const section = `[${date}] ## ${trimmed}`;
    sections.push(section);
  }

  // If no ## headings found, import the whole file as one entry
  if (sections.length === 0 && content.trim().length > 50) {
    sections.push(`[${date}] ${content.trim()}`);
  }

  return sections;
}

function importArchival(): void {
  const memoryDir = path.join(CLAWD_DIR, "memory");
  if (!fs.existsSync(memoryDir)) {
    console.log("[archival] memory/ directory not found, skipping");
    return;
  }

  const files = fs.readdirSync(memoryDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  console.log(`[archival] Found ${files.length} memory files`);

  if (DRY_RUN) {
    for (const file of files) {
      const content = fs.readFileSync(path.join(memoryDir, file), "utf-8");
      const sections = splitIntoSections(content, file);
      console.log(`[archival] DRY RUN — ${file}: ${sections.length} section(s)`);
    }
    return;
  }

  const db = openDb();
  let inserted = 0;
  let skipped = 0;

  try {
    for (const file of files) {
      const filePath = path.join(memoryDir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const sections = splitIntoSections(content, file);

      // Use file mtime as approximate timestamp
      const stat = fs.statSync(filePath);
      const timestamp = stat.mtimeMs;

      for (const section of sections) {
        const hash = hashContent(section);
        const existing = db.exists.get(hash);
        if (existing) {
          skipped++;
          continue;
        }

        const id = crypto.randomUUID();
        db.insert.run(id, section, `openclaw:memory/${file}`, timestamp, hash);
        inserted++;
      }

      console.log(`[archival] ${file}: ${sections.length} section(s)`);
    }
  } finally {
    db.close();
  }

  console.log(`[archival] Done: ${inserted} inserted, ${skipped} skipped (already present)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`Importing OpenClaw memory into bryti`);
console.log(`  User ID:  ${USER_ID}`);
console.log(`  Data dir: ${BRYTI_DATA_DIR}`);
console.log(`  Dry run:  ${DRY_RUN}`);
console.log("");

importCoreMemory();
importArchival();

console.log("\nDone. Restart bryti for core memory changes to take effect.");
