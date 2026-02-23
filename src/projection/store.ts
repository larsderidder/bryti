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
   * resolution='exact'. Used by the 5-minute scheduler check. window_minutes
   * must be larger than the scheduler tick to avoid missing events that fall
   * between ticks.
   */
  getExactDue(window_minutes: number): Projection[];

  /**
   * Mark a projection's status (done/cancelled/passed).
   * Returns false if the id does not exist.
   */
  resolve(id: string, status: ProjectionStatus): boolean;

  /**
   * Rearm a recurring projection: reset it to pending with a new resolved_when
   * and clear resolved_at so it looks fresh for the next cycle. Only called
   * after a recurring projection fires; non-recurring projections should be
   * resolved instead.
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
    embed?: (text: string) => Promise<number[] | null>,
    similarityThreshold?: number,
  ): Promise<Projection[]>;

  /**
   * Mark pending projections as 'passed' when their resolved_when is more than
   * threshold_hours hours in the past and they are still pending. Exact-resolution
   * projections always expire after 1 hour; other resolutions use threshold_hours.
   * Someday projections are never expired by time.
   * Returns the number of rows updated.
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
 *
 * Schema overview
 * ---------------
 * projections
 *   Primary record. Holds the summary, timing fields (raw_when, resolved_when,
 *   resolution), recurrence cron, trigger_on_fact keyword, and status.
 *
 * projection_links
 *   Many-to-many cross-reference between projections (e.g., "this task belongs
 *   to that project"). Links are stored as a JSON array on the projections row
 *   (linked_ids) and optionally in this table for reverse lookups.
 *
 * projection_dependencies
 *   DAG edges. An observer projection waits for its subject projection(s) to
 *   reach a condition before it becomes active. Conditions are either a status
 *   keyword ("done", "cancelled", "passed") or an LLM-evaluated expression.
 *
 * Lifecycle state machine
 * -----------------------
 *   pending  →  done       (agent or user explicitly resolves it)
 *   pending  →  cancelled  (agent or user cancels it)
 *   pending  →  passed     (autoExpire: the time window elapsed without action)
 *
 * Recurring projections return to pending after each firing (see rearm()).
 * Trigger-based projections become active (resolution='exact') when a matching
 * fact arrives via checkTriggers(), then fire on the next scheduler tick.
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

    // resolved_when is the normalised ISO datetime derived from raw_when (the
    // caller is responsible for resolving natural-language expressions like
    // "next Monday" before calling add()). For trigger_on_fact projections no
    // resolved_when is needed upfront — checkTriggers() sets it at fire time.
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

    // Each entry in depends_on creates a DAG edge: this new projection (observer)
    // will not activate until the referenced subject projection reaches its condition.
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
      // SQL note: the ORDER BY uses a CASE expression to push rows with no
      // resolved_when (someday / trigger-only items) to the end; time-bound
      // projections are sorted ascending by resolved_when. Trigger-based
      // projections also land here when they have no resolved_when yet; the
      // caller can identify them by the non-null trigger_on_fact column.
      const rows = stmtUpcoming.all(String(horizon_days)) as ProjectionRow[];
      return rows.map(rowToProjection);
    },

    getExactDue(window_minutes) {
      // Filters to resolution='exact' only: day/week/month projections are surfaced
      // through getUpcoming, not here. window_minutes must be larger than the
      // scheduler tick (5 min) so that projections due between ticks are never
      // skipped. The lower bound ('-10 minutes') prevents re-firing events that
      // already fired but whose resolved_at hasn't been written yet.
      const rows = stmtExactDue.all(String(window_minutes)) as ProjectionRow[];
      return rows.map(rowToProjection);
    },

    resolve(id, status) {
      const result = stmtResolve.run(status, id) as { changes: number };
      return result.changes > 0;
    },

    rearm(id, nextResolvedWhen) {
      // Only called for recurring projections after they fire. Resets status to
      // 'pending' and advances resolved_when to the next occurrence so the
      // scheduler will pick it up again. resolved_at is cleared so the projection
      // looks fresh for the next cycle.
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

        // Fast path (keyword matching): split trigger into tokens and require
        // every token to appear in the fact text. This is O(n*m) but fast for
        // short triggers. If all keywords are present the projection fires
        // immediately, without involving the embedding model.
        const keywords = trigger.split(/\W+/).filter(Boolean);
        const allPresent = keywords.every((kw) => factLower.includes(kw));

        if (allPresent) {
          // Activate immediately: set resolved_when to now and resolution to
          // 'exact' so the scheduler will fire this projection on the next tick.
          // trigger_on_fact is cleared so it won't re-match future facts.
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

      // Slow path (semantic matching): embed both the fact and the trigger phrase,
      // then compute cosine similarity. Projections that score above
      // similarityThreshold are activated the same way as keyword matches.
      // The projection is resolved immediately on trigger (rather than queued)
      // because by the time checkTriggers() runs the activating fact already
      // exists — there is no point delaying the notification.
      if (embeddingFallback.length > 0 && embed) {
        const factVec = await embed(factContent);
        if (factVec === null) {
          // Embeddings unavailable; skip semantic matching entirely.
          return activated;
        }
        for (const row of embeddingFallback) {
          const triggerVec = await embed(row.trigger_on_fact!);
          if (triggerVec === null) continue;
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

    /**
     * Marks pending projections as 'passed' when their resolved_when timestamp
     * is more than threshold_hours hours in the past and they are still pending.
     * Exact-resolution projections use a fixed 1-hour window (they either fired
     * via the scheduler or were missed); all other resolutions use the caller-
     * supplied threshold. Someday projections are never expired by time.
     *
     * Returns the number of rows updated.
     */
    autoExpire(threshold_hours = 24) {
      const result = stmtExpire.run(String(-threshold_hours)) as { changes: number };
      return result.changes;
    },

    linkDependency(observerId, subjectId, condition, conditionType) {
      return validateAndInsertDependency(observerId, subjectId, condition, conditionType);
    },

    /**
     * Evaluates the dependency DAG and activates any observer projections whose
     * conditions are all satisfied.
     *
     * Evaluation is performed in a fixed-point loop (up to 10 iterations):
     * activating an observer may satisfy a condition for another observer further
     * up the chain, so the loop re-runs until no new activations occur.
     *
     * Condition types:
     *   'status_change' — satisfied when subject.status equals the condition
     *     string (e.g., "done"). Evaluated entirely in SQL-land via a JOIN.
     *   'llm' — not yet implemented; always returns false here. Future
     *     implementation would call completeSimple() to evaluate the condition
     *     expression against the current state of both projections and the
     *     agent's archival memory.
     *
     * Returns the total number of observer projections activated.
     */
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
            // TODO: 'llm' condition type is not yet implemented. A future
            // implementation would call completeSimple() with the condition
            // string and the subject projection's current state to produce a
            // boolean verdict, rather than relying on a fixed status keyword.
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
