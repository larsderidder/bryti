/**
 * Worker registry: in-memory tracking of active and recently-completed workers.
 * Each entry records status, timing, file paths, and the timeout handle.
 */

export type WorkerStatus = "running" | "complete" | "failed" | "timeout" | "cancelled";

export interface WorkerEntry {
  workerId: string;
  status: WorkerStatus;
  /** Short summary of what the worker is doing. */
  task: string;
  /** Absolute path to the worker's result file. */
  resultPath: string;
  /** Absolute path to the worker's directory. */
  workerDir: string;
  startedAt: Date;
  completedAt: Date | null;
  /** Error message if status is "failed" or "timeout". */
  error: string | null;
  /** Model used for this worker. */
  model: string;
  /** Abort the running session (set when session is started). */
  abort: (() => Promise<void>) | null;
  /** Timeout handle for forced termination. */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

export interface WorkerRegistry {
  /** Register a new worker. Returns the entry. */
  register(entry: Omit<WorkerEntry, "completedAt">): WorkerEntry;

  /** Get a worker by id. Returns null if not found. */
  get(workerId: string): WorkerEntry | null;

  /** Update mutable fields of a worker entry. */
  update(workerId: string, updates: Partial<Pick<WorkerEntry, "status" | "completedAt" | "error" | "abort" | "timeoutHandle">>): void;

  /** Count workers with status "running". */
  runningCount(): number;

  /** Remove a worker entry from the registry. */
  remove(workerId: string): void;

  /** List all entries (for worker_check). */
  list(): WorkerEntry[];
}

export function createWorkerRegistry(): WorkerRegistry {
  const entries = new Map<string, WorkerEntry>();

  return {
    register(entry) {
      const full: WorkerEntry = { ...entry, completedAt: null };
      entries.set(entry.workerId, full);
      return full;
    },

    get(workerId) {
      return entries.get(workerId) ?? null;
    },

    update(workerId, updates) {
      const entry = entries.get(workerId);
      if (!entry) return;
      Object.assign(entry, updates);
    },

    runningCount() {
      let count = 0;
      for (const entry of entries.values()) {
        if (entry.status === "running") count++;
      }
      return count;
    },

    remove(workerId) {
      entries.delete(workerId);
    },

    list() {
      return Array.from(entries.values());
    },
  };
}
