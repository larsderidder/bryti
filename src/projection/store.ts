/**
 * Projection store: SQLite-backed storage for forward-looking agent memory.
 *
 * Stores future events, plans, and commitments. Projections are temporal:
 * they have a resolution (exact/day/week/month/someday) and a lifecycle
 * (pending -> done/cancelled/passed).
 *
 * Uses the same per-user database as archival memory (memory.db) but its
 * own table. No imports from the memory layer.
 *
 * Schema:
 *   id            - UUID primary key
 *   summary       - one-line description of the event/expectation
 *   raw_when      - what the user said ("tomorrow at 10", "next week")
 *   resolved_when - ISO datetime or date the agent resolved raw_when to
 *   resolution    - granularity: exact | day | week | month | someday
 *   context       - optional free-text context (linked events, notes)
 *   linked_ids    - JSON array of related projection ids
 *   status        - pending | done | cancelled | passed
 *   created_at    - ISO datetime
 *   resolved_at   - ISO datetime when status changed from pending
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectionResolution = "exact" | "day" | "week" | "month" | "someday";
export type ProjectionStatus = "pending" | "done" | "cancelled" | "passed";

export interface Projection {
  id: string;
  summary: string;
  raw_when: string | null;
  resolved_when: string | null;
  resolution: ProjectionResolution;
  context: string | null;
  linked_ids: string[];
  status: ProjectionStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface ProjectionStore {
  /** Add a projection. Returns the new id. */
  add(params: {
    summary: string;
    raw_when?: string;
    resolved_when?: string;
    resolution?: ProjectionResolution;
    context?: string;
    linked_ids?: string[];
  }): string;

  /**
   * Get active (pending) projections within the next horizon_days days.
   * Always includes someday projections.
   */
  getUpcoming(horizon_days: number): Projection[];

  /**
   * Get pending projections due in the next window_minutes minutes that have
   * resolution='exact'. Used by the 5-minute scheduler check.
   */
  getExactDue(window_minutes: number): Projection[];

  /**
   * Mark a projection's status (done/cancelled/passed).
   * Returns false if the id does not exist.
   */
  resolve(id: string, status: ProjectionStatus): boolean;

  /**
   * Auto-expire projections whose resolved_when has passed by more than
   * threshold_hours hours. Returns the number of rows updated.
   */
  autoExpire(threshold_hours?: number): number;

  /** Close the database connection. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ProjectionRow {
  id: string;
  summary: string;
  raw_when: string | null;
  resolved_when: string | null;
  resolution: string;
  context: string | null;
  linked_ids: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

function rowToProjection(row: ProjectionRow): Projection {
  let linked_ids: string[] = [];
  if (row.linked_ids) {
    try {
      linked_ids = JSON.parse(row.linked_ids) as string[];
    } catch {
      linked_ids = [];
    }
  }
  return {
    id: row.id,
    summary: row.summary,
    raw_when: row.raw_when,
    resolved_when: row.resolved_when,
    resolution: row.resolution as ProjectionResolution,
    context: row.context,
    linked_ids,
    status: row.status as ProjectionStatus,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open (or create) the per-user projection store in the same DB file as
 * archival memory.
 */
export function createProjectionStore(userId: string, dataDir: string): ProjectionStore {
  const userDir = path.join(dataDir, "users", userId);
  fs.mkdirSync(userDir, { recursive: true });

  const dbPath = path.join(userDir, "memory.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS projections (
      id           TEXT PRIMARY KEY,
      summary      TEXT NOT NULL,
      raw_when     TEXT,
      resolved_when TEXT,
      resolution   TEXT NOT NULL DEFAULT 'day',
      context      TEXT,
      linked_ids   TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   TEXT NOT NULL,
      resolved_at  TEXT
    );
  `);

  const stmtInsert = db.prepare(`
    INSERT INTO projections
      (id, summary, raw_when, resolved_when, resolution, context, linked_ids, status, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  const stmtUpcoming = db.prepare(`
    SELECT * FROM projections
    WHERE status = 'pending'
      AND (
        resolution = 'someday'
        OR resolved_when IS NULL
        OR resolved_when <= datetime('now', ? || ' days')
      )
    ORDER BY
      CASE WHEN resolved_when IS NULL THEN 1 ELSE 0 END,
      resolved_when ASC
  `);

  const stmtExactDue = db.prepare(`
    SELECT * FROM projections
    WHERE status = 'pending'
      AND resolution = 'exact'
      AND resolved_when IS NOT NULL
      AND resolved_when <= datetime('now', ? || ' minutes')
      AND resolved_when > datetime('now', '-10 minutes')
    ORDER BY resolved_when ASC
  `);

  const stmtResolve = db.prepare(`
    UPDATE projections
    SET status = ?, resolved_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `);

  const stmtExpire = db.prepare(`
    UPDATE projections
    SET status = 'passed', resolved_at = datetime('now')
    WHERE status = 'pending'
      AND resolution != 'someday'
      AND resolved_when IS NOT NULL
      AND resolved_when < datetime('now', ? || ' hours')
  `);

  return {
    add({ summary, raw_when, resolved_when, resolution, context, linked_ids }) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      stmtInsert.run(
        id,
        summary,
        raw_when ?? null,
        resolved_when ?? null,
        resolution ?? "day",
        context ?? null,
        linked_ids ? JSON.stringify(linked_ids) : null,
        now,
      );
      return id;
    },

    getUpcoming(horizon_days) {
      const rows = stmtUpcoming.all(String(horizon_days)) as ProjectionRow[];
      return rows.map(rowToProjection);
    },

    getExactDue(window_minutes) {
      const rows = stmtExactDue.all(String(window_minutes)) as ProjectionRow[];
      return rows.map(rowToProjection);
    },

    resolve(id, status) {
      const result = stmtResolve.run(status, id) as { changes: number };
      return result.changes > 0;
    },

    autoExpire(threshold_hours = 24) {
      const result = stmtExpire.run(String(-threshold_hours)) as { changes: number };
      return result.changes;
    },

    close() {
      db.close();
    },
  };
}
