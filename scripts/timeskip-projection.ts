/**
 * Time-skip a projection for testing.
 *
 * Moves a projection's resolved_when to now + N minutes so the exact-time
 * scheduler picks it up on the next tick. Much simpler than faking the clock.
 *
 * Usage:
 *   npx tsx scripts/timeskip-projection.ts [--user-id default-user] [--minutes 2] [--list]
 *
 * Examples:
 *   npx tsx scripts/timeskip-projection.ts --list
 *   npx tsx scripts/timeskip-projection.ts --id <uuid> --minutes 2
 *   npx tsx scripts/timeskip-projection.ts --summary "Hashnode" --minutes 2
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const PIBOT_DATA_DIR = process.env.PIBOT_DATA_DIR ?? "./data";
const USER_ID = process.argv.includes("--user-id")
  ? process.argv[process.argv.indexOf("--user-id") + 1]
  : "default-user";
const MINUTES = process.argv.includes("--minutes")
  ? Number(process.argv[process.argv.indexOf("--minutes") + 1])
  : 2;
const LIST = process.argv.includes("--list");
const ID = process.argv.includes("--id")
  ? process.argv[process.argv.indexOf("--id") + 1]
  : undefined;
const SUMMARY = process.argv.includes("--summary")
  ? process.argv[process.argv.indexOf("--summary") + 1]
  : undefined;

const dbPath = path.join(PIBOT_DATA_DIR, "users", USER_ID, "memory.db");
if (!fs.existsSync(dbPath)) {
  console.error(`No memory.db found at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);

if (LIST) {
  const rows = db.prepare(
    "SELECT id, summary, resolved_when, resolution, status FROM projections ORDER BY resolved_when ASC",
  ).all() as any[];

  if (rows.length === 0) {
    console.log("No projections found.");
  } else {
    console.log("Projections:\n");
    for (const row of rows) {
      const marker = row.status === "pending" ? "⏳" : row.status === "passed" ? "✅" : "❌";
      console.log(`${marker} [${row.resolution}] ${row.summary}`);
      console.log(`   id: ${row.id}`);
      console.log(`   when: ${row.resolved_when ?? "(someday)"}`);
      console.log("");
    }
  }
  db.close();
  process.exit(0);
}

if (!ID && !SUMMARY) {
  console.error("Provide --id <uuid> or --summary <text> to select a projection, or --list to show all.");
  process.exit(1);
}

// Find the projection
let row: any;
if (ID) {
  row = db.prepare("SELECT * FROM projections WHERE id = ?").get(ID);
} else {
  row = db.prepare(
    "SELECT * FROM projections WHERE summary LIKE ? AND status = 'pending' LIMIT 1",
  ).get(`%${SUMMARY}%`);
}

if (!row) {
  console.error(`No pending projection found matching: ${ID ?? SUMMARY}`);
  process.exit(1);
}

// Compute new time: now + MINUTES
const newTime = new Date(Date.now() + MINUTES * 60 * 1000);
const newTimeStr = newTime.toISOString().slice(0, 16).replace("T", " ");

db.prepare(
  "UPDATE projections SET resolved_when = ?, resolution = 'exact' WHERE id = ?",
).run(newTimeStr, row.id);

console.log(`Timeskipped projection:`);
console.log(`  Summary: ${row.summary}`);
console.log(`  Old when: ${row.resolved_when ?? "(none)"}`);
console.log(`  New when: ${newTimeStr} UTC (fires in ~${MINUTES} min)`);
console.log(`\nThe scheduler will pick it up on the next 5-minute tick.`);

db.close();
