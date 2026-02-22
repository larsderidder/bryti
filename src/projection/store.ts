/**
 * Projection store: SQLite-backed storage for forward-looking agent memory.
 *
 * Stores future events, plans, and commitments with a resolution
 * (exact/day/week/month/someday) and lifecycle (pending -> done/cancelled/passed).
 *
 * Lives in the same per-user memory.db as archival memory, its own table.
 *
 * Key columns: summary, raw_when (what the user said), resolved_when (ISO
 * datetime), resolution, recurrence (cron), trigger_on_fact (keyword trigger),
 * status, and dependencies (separate table for DAG relationships).
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cosineSimilarity } from "../util/math.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectionResolution = "exact" | "day" | "week" | "month" | "someday";
export type ProjectionStatus = "pending" | "done" | "cancelled" | "passed";
export type DependencyConditionType = "status_change" | "llm";

export interface ProjectionDependency {
  id: string;
  observer_id: string;
  subject_id: string;
  condition: string;
  condition_type: DependencyConditionType;
  created_at: string;
}

export interface ProjectionDependencyInput {
  subject_id: string;
  condition: string;
  condition_type?: DependencyConditionType;
}

export interface Projection {
  id: string;
  summary: string;
  raw_when: string | null;
  resolved_when: string | null;
  resolution: ProjectionResolution;
  recurrence: string | null;
  trigger_on_fact: string | null;
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
    recurrence?: string;
    trigger_on_fact?: string;
    context?: string;
    linked_ids?: string[];
    depends_on?: ProjectionDependencyInput[];
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
   * Rearm a recurring projection: reset it to pending with a new resolved_when.
   * Used by the scheduler when a recurring projection fires.
   * Returns false if the id does not exist.
   */
  rearm(id: string, nextResolvedWhen: string): boolean;

  /**
   * Check pending projections whose trigger_on_fact condition matches the given
   * fact content. First tries keyword matching (all keywords present). For
   * non-matches, falls back to embedding cosine similarity if an embed function
   * is provided. Activate each match by setting resolved_when to now and
   * resolution to 'exact', then clear its trigger_on_fact.
   * Returns the list of projections that were activated.
   */
  checkTriggers(
    factContent: string,
    embed?: (text: string) => Promise<number[]>,
    similarityThreshold?: number,
  ): Promise<Projection[]>;

  /**
   * Auto-expire projections whose resolved_when has passed by more than
   * threshold_hours hours. Returns the number of rows updated.
   */
  autoExpire(threshold_hours?: number): number;

  /**
   * Link an existing observer projection to a subject projection.
   * Throws if the relationship is invalid (missing projection, cycle, or chain too deep).
   */
  linkDependency(
    observerId: string,
    subjectId: string,
    condition: string,
    conditionType?: DependencyConditionType,
  ): string;

  /**
   * Evaluate pending dependencies and activate observer projections whose
   * conditions are satisfied.
   */
  evaluateDependencies(): number;

  /** List dependencies, optionally filtered by observer projection id. */
  getDependencies(observerId?: string): ProjectionDependency[];

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
  recurrence: string | null;
  trigger_on_fact: string | null;
  context: string | null;
  linked_ids: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

interface ProjectionDependencyRow {
  id: string;
  observer_id: string;
  subject_id: string;
  condition: string;
  condition_type: string;
  created_at: string;
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
    recurrence: row.recurrence,
    trigger_on_fact: row.trigger_on_fact,
    context: row.context,
    linked_ids,
    status: row.status as ProjectionStatus,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

function rowToDependency(row: ProjectionDependencyRow): ProjectionDependency {
  return {
    id: row.id,
    observer_id: row.observer_id,
    subject_id: row.subject_id,
    condition: row.condition,
    condition_type: row.condition_type as DependencyConditionType,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open (or create) the per-user projection store. Shares memory.db with
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
      id              TEXT PRIMARY KEY,
      summary         TEXT NOT NULL,
      raw_when        TEXT,
      resolved_when   TEXT,
      resolution      TEXT NOT NULL DEFAULT 'day',
      recurrence      TEXT,
      trigger_on_fact TEXT,
      context         TEXT,
      linked_ids      TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TEXT NOT NULL,
      resolved_at     TEXT
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS projection_dependencies (
      id             TEXT PRIMARY KEY,
      observer_id    TEXT NOT NULL,
      subject_id     TEXT NOT NULL,
      condition      TEXT NOT NULL,
      condition_type TEXT NOT NULL DEFAULT 'status_change',
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate: add columns to existing databases that predate these features.
  for (const ddl of [
    `ALTER TABLE projections ADD COLUMN recurrence TEXT;`,
    `ALTER TABLE projections ADD COLUMN trigger_on_fact TEXT;`,
  ]) {
    try {
      db.exec(ddl);
    } catch {
      // Column already exists — ignore
    }
  }

  const stmtInsert = db.prepare(`
    INSERT INTO projections
      (id, summary, raw_when, resolved_when, resolution, recurrence, trigger_on_fact, context, linked_ids, status, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const stmtInsertDependency = db.prepare(`
    INSERT INTO projection_dependencies
      (id, observer_id, subject_id, condition, condition_type, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?)
  `);
  const stmtProjectionExists = db.prepare(`
    SELECT id FROM projections WHERE id = ?
  `);
  const stmtDependencyEdges = db.prepare(`
    SELECT subject_id, observer_id FROM projection_dependencies
  `);
  const stmtDependenciesForEvaluation = db.prepare(`
    SELECT
      d.id,
      d.observer_id,
      d.subject_id,
      d.condition,
      d.condition_type,
      d.created_at,
      s.status AS subject_status
    FROM projection_dependencies d
    JOIN projections o ON o.id = d.observer_id
    JOIN projections s ON s.id = d.subject_id
    WHERE o.status = 'pending'
  `);
  const stmtActivateObserver = db.prepare(`
    UPDATE projections
    SET resolved_when = datetime('now'), resolution = 'exact'
    WHERE id = ? AND status = 'pending'
  `);
  const stmtDeleteDependenciesByObserver = db.prepare(`
    DELETE FROM projection_dependencies WHERE observer_id = ?
  `);
  const stmtDependenciesList = db.prepare(`
    SELECT * FROM projection_dependencies ORDER BY created_at ASC
  `);
  const stmtDependenciesListByObserver = db.prepare(`
    SELECT * FROM projection_dependencies WHERE observer_id = ? ORDER BY created_at ASC
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

  const stmtRearm = db.prepare(`
    UPDATE projections
    SET status = 'pending', resolved_when = ?, resolved_at = NULL
    WHERE id = ?
  `);

  // Fetch all pending projections that have a trigger_on_fact set.
  const stmtPendingWithTriggers = db.prepare(`
    SELECT * FROM projections
    WHERE status = 'pending'
      AND trigger_on_fact IS NOT NULL
      AND trigger_on_fact != ''
  `);

  // Activate a trigger-matched projection: set resolved_when to now, resolution
  // to 'exact', and clear trigger_on_fact so it won't re-match on future inserts.
  const stmtActivateTrigger = db.prepare(`
    UPDATE projections
    SET resolved_when = datetime('now'), resolution = 'exact', trigger_on_fact = NULL
    WHERE id = ? AND status = 'pending'
  `);

  const stmtExpire = db.prepare(`
    UPDATE projections
    SET status = 'passed', resolved_at = datetime('now')
    WHERE status = 'pending'
      AND resolution != 'someday'
      AND resolved_when IS NOT NULL
      AND (
        -- Exact-time items expire after 1 hour (they either fired or were missed)
        (resolution = 'exact' AND resolved_when < datetime('now', '-1 hours'))
        OR
        -- Day/week/month items expire after the configured threshold
        (resolution != 'exact' AND resolved_when < datetime('now', ? || ' hours'))
      )
  `);

  function inferConditionType(condition: string, explicit?: DependencyConditionType): DependencyConditionType {
    if (explicit) return explicit;
    return ["done", "cancelled", "passed"].includes(condition) ? "status_change" : "llm";
  }

  function validateAndInsertDependency(
    observerId: string,
    subjectId: string,
    condition: string,
    conditionType?: DependencyConditionType,
  ): string {
    if (!condition.trim()) {
      throw new Error("Dependency condition must not be empty");
    }
    const observerExists = stmtProjectionExists.get(observerId) as { id: string } | undefined;
    if (!observerExists) {
      throw new Error(`Observer projection not found: ${observerId}`);
    }
    const subjectExists = stmtProjectionExists.get(subjectId) as { id: string } | undefined;
    if (!subjectExists) {
      throw new Error(`Subject projection not found: ${subjectId}`);
    }
    if (observerId === subjectId) {
      throw new Error("Projection cannot depend on itself");
    }

    const existingEdges = stmtDependencyEdges.all() as Array<{ subject_id: string; observer_id: string }>;
    const edges = existingEdges.map((e) => ({ subject: e.subject_id, observer: e.observer_id }));
    edges.push({ subject: subjectId, observer: observerId });

    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      const list = adjacency.get(edge.subject) ?? [];
      list.push(edge.observer);
      adjacency.set(edge.subject, list);
    }

    // Cycle check: if observer can already reach subject, adding subject->observer closes a cycle.
    const stack = [observerId];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === subjectId) {
        throw new Error("Dependency cycle detected");
      }
      if (visited.has(current)) continue;
      visited.add(current);
      const next = adjacency.get(current) ?? [];
      for (const n of next) stack.push(n);
    }

    // Depth check across the full DAG after the new edge is considered.
    const depthMemo = new Map<string, number>();
    const visiting = new Set<string>();
    const longestFrom = (node: string): number => {
      const cached = depthMemo.get(node);
      if (cached !== undefined) return cached;
      if (visiting.has(node)) {
        // Defensive guard; cycle should be caught above.
        throw new Error("Dependency cycle detected");
      }
      visiting.add(node);
      const children = adjacency.get(node) ?? [];
      let best = 1;
      for (const child of children) {
        best = Math.max(best, 1 + longestFrom(child));
      }
      visiting.delete(node);
      depthMemo.set(node, best);
      return best;
    };

    const nodes = new Set<string>([observerId, subjectId]);
    for (const edge of edges) {
      nodes.add(edge.subject);
      nodes.add(edge.observer);
    }
    let maxDepth = 0;
    for (const n of nodes) {
      maxDepth = Math.max(maxDepth, longestFrom(n));
    }
    if (maxDepth > 5) {
      throw new Error("Dependency chain too deep (max 5)");
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    stmtInsertDependency.run(
      id,
      observerId,
      subjectId,
      condition.trim(),
      inferConditionType(condition.trim(), conditionType),
      now,
    );
    return id;
  }

  const addWithDependencies = db.transaction((params: {
    summary: string;
    raw_when?: string;
    resolved_when?: string;
    resolution?: ProjectionResolution;
    recurrence?: string;
    trigger_on_fact?: string;
    context?: string;
    linked_ids?: string[];
    depends_on?: ProjectionDependencyInput[];
  }): string => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    stmtInsert.run(
      id,
      params.summary,
      params.raw_when ?? null,
      params.resolved_when ?? null,
      params.resolution ?? "day",
      params.recurrence ?? null,
      params.trigger_on_fact ?? null,
      params.context ?? null,
      params.linked_ids ? JSON.stringify(params.linked_ids) : null,
      now,
    );

    for (const dep of params.depends_on ?? []) {
      validateAndInsertDependency(id, dep.subject_id, dep.condition, dep.condition_type);
    }
    return id;
  });

  return {
    add({ summary, raw_when, resolved_when, resolution, recurrence, trigger_on_fact, context, linked_ids, depends_on }) {
      return addWithDependencies({
        summary,
        raw_when,
        resolved_when,
        resolution,
        recurrence,
        trigger_on_fact,
        context,
        linked_ids,
        depends_on,
      });
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

    rearm(id, nextResolvedWhen) {
      const result = stmtRearm.run(nextResolvedWhen, id) as { changes: number };
      return result.changes > 0;
    },

    async checkTriggers(factContent, embed?, similarityThreshold = 0.55) {
      const candidates = stmtPendingWithTriggers.all() as ProjectionRow[];
      if (candidates.length === 0) return [];

      // Normalise the incoming fact to lowercase words for matching.
      const factLower = factContent.toLowerCase();

      const activated: Projection[] = [];
      const embeddingFallback: ProjectionRow[] = [];

      for (const row of candidates) {
        const trigger = row.trigger_on_fact!.toLowerCase().trim();
        if (!trigger) continue;

        // Fast path: keyword match (all keywords present in fact content).
        const keywords = trigger.split(/\W+/).filter(Boolean);
        const allPresent = keywords.every((kw) => factLower.includes(kw));

        if (allPresent) {
          const result = stmtActivateTrigger.run(row.id) as { changes: number };
          if (result.changes > 0) {
            const updated = { ...row, resolved_when: new Date().toISOString().slice(0, 16).replace("T", " "), resolution: "exact", trigger_on_fact: null };
            activated.push(rowToProjection(updated as ProjectionRow));
          }
        } else if (embed) {
          // Skip embedding fallback for triggers that contain specific identifiers
          // (worker IDs, UUIDs, etc.). These should only match on exact keywords,
          // not semantic similarity. "worker w-abc123 complete" is semantically
          // similar to "worker w-xyz789 complete" but they're about different workers.
          const hasSpecificId = /w-[0-9a-f]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-/.test(trigger);
          if (!hasSpecificId) {
            embeddingFallback.push(row);
          }
        }
      }

      // Slow path: embedding similarity for keyword misses.
      if (embeddingFallback.length > 0 && embed) {
        const factVec = await embed(factContent);
        for (const row of embeddingFallback) {
          const triggerVec = await embed(row.trigger_on_fact!);
          const sim = cosineSimilarity(factVec, triggerVec);
          if (sim >= similarityThreshold) {
            const result = stmtActivateTrigger.run(row.id) as { changes: number };
            if (result.changes > 0) {
              const updated = { ...row, resolved_when: new Date().toISOString().slice(0, 16).replace("T", " "), resolution: "exact", trigger_on_fact: null };
              activated.push(rowToProjection(updated as ProjectionRow));
            }
          }
        }
      }

      return activated;
    },

    autoExpire(threshold_hours = 24) {
      const result = stmtExpire.run(String(-threshold_hours)) as { changes: number };
      return result.changes;
    },

    linkDependency(observerId, subjectId, condition, conditionType) {
      return validateAndInsertDependency(observerId, subjectId, condition, conditionType);
    },

    evaluateDependencies() {
      let activatedTotal = 0;
      // Iterate until stable so multiple newly-satisfied observers can activate in one pass.
      for (let iteration = 0; iteration < 10; iteration++) {
        const rows = stmtDependenciesForEvaluation.all() as Array<ProjectionDependencyRow & {
          subject_status: string;
        }>;
        const byObserver = new Map<string, Array<ProjectionDependencyRow & { subject_status: string }>>();
        for (const row of rows) {
          const group = byObserver.get(row.observer_id) ?? [];
          group.push(row);
          byObserver.set(row.observer_id, group);
        }

        let activatedThisIteration = 0;
        for (const [observerId, deps] of byObserver) {
          const allMet = deps.every((dep) => {
            if (dep.condition_type === "status_change") {
              return dep.subject_status === dep.condition;
            }
            // LLM-backed conditions are stored, but evaluated by higher-level logic.
            return false;
          });
          if (!allMet) continue;

          const result = stmtActivateObserver.run(observerId) as { changes: number };
          if (result.changes > 0) {
            stmtDeleteDependenciesByObserver.run(observerId);
            activatedThisIteration++;
          }
        }

        activatedTotal += activatedThisIteration;
        if (activatedThisIteration === 0) break;
      }
      return activatedTotal;
    },

    getDependencies(observerId) {
      const rows = observerId
        ? (stmtDependenciesListByObserver.all(observerId) as ProjectionDependencyRow[])
        : (stmtDependenciesList.all() as ProjectionDependencyRow[]);
      return rows.map(rowToDependency);
    },

    close() {
      db.close();
    },
  };
}
