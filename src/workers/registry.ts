/**
 * Worker registry: in-memory tracking of active and recently-completed workers.
 * Each entry records status, timing, file paths, and the timeout handle.
 */

export type WorkerStatus = "queued" | "running" | "complete" | "failed" | "timeout" | "cancelled";

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
  /**
   * Abort the running session. Set asynchronously after session creation in
   * spawnWorkerSession. It is null in the brief window between registry.register()
   * and the session coming up. Always check for null before calling.
   */
  abort: (() => Promise<void>) | null;
  /**
   * Steer the running session. Set asynchronously after session creation.
   * Guidance sent before this exists is stored in pendingSteering and flushed
   * as soon as the session is available.
   */
  steer: ((guidance: string) => Promise<void>) | null;
  /** Most recent guidance waiting for a worker session to become steerable. */
  pendingSteering: string | null;
  /**
   * Handle for the forced-termination timer set in spawnWorkerSession.
   * Null when the worker has already finished (timer was cleared) or has not
   * yet started. Stored here so worker_interrupt can cancel it.
   */
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

export interface WorkerRegistry {
  /** Register a new worker. Returns the entry. */
  register(entry: Omit<WorkerEntry, "completedAt" | "steer" | "pendingSteering"> & Partial<Pick<WorkerEntry, "steer" | "pendingSteering">>): WorkerEntry;

  /** Get a worker by id. Returns null if not found. */
  get(workerId: string): WorkerEntry | null;

  /** Update mutable fields of a worker entry. */
  update(workerId: string, updates: Partial<Pick<WorkerEntry, "status" | "completedAt" | "error" | "abort" | "steer" | "pendingSteering" | "timeoutHandle">>): void;

  /** Count workers with status "running". */
  runningCount(): number;

  /** Count workers waiting to start. */
  queuedCount(): number;

  /** Return the next queued worker in FIFO registration order. */
  nextQueued(): WorkerEntry | null;

  /** Return a queued worker's 1-based queue position, or null if not queued. */
  queuePosition(workerId: string): number | null;

  /** Remove a worker entry from the registry. */
  remove(workerId: string): void;

  /** List all entries (for worker_check). */
  list(): WorkerEntry[];
}

export function createWorkerRegistry(): WorkerRegistry {
  const entries = new Map<string, WorkerEntry>();

  return {
    register(entry) {
      const full: WorkerEntry = {
        ...entry,
        steer: entry.steer ?? null,
        pendingSteering: entry.pendingSteering ?? null,
        completedAt: null,
      };
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

    queuedCount() {
      let count = 0;
      for (const entry of entries.values()) {
        if (entry.status === "queued") count++;
      }
      return count;
    },

    nextQueued() {
      for (const entry of entries.values()) {
        if (entry.status === "queued") return entry;
      }
      return null;
    },

    queuePosition(workerId) {
      let position = 0;
      for (const entry of entries.values()) {
        if (entry.status !== "queued") continue;
        position++;
        if (entry.workerId === workerId) return position;
      }
      return null;
    },

    remove(workerId) {
      entries.delete(workerId);
    },

    list() {
      return Array.from(entries.values());
    },
  };
}
