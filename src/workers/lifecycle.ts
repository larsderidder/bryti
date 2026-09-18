import type { WorkerEntry, WorkerRegistry } from "./registry.js";
import { writeWorkerStatus } from "./recovery.js";

/** Persist a terminal decision before aborting so late callbacks cannot revive work. */
export async function stopWorker(
  registry: WorkerRegistry,
  entry: WorkerEntry,
  status: "cancelled" | "timeout" | "interrupted",
  error: string | null,
): Promise<void> {
  if (entry.status !== "running" && entry.status !== "queued") {
    return;
  }
  const wasRunning = entry.status === "running";
  const completedAt = new Date();
  writeWorkerStatus(entry.workerDir, {
    worker_id: entry.workerId,
    status,
    task: entry.task,
    started_at: entry.startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    model: entry.model,
    error,
    result_path: entry.resultPath,
  });
  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
  }
  registry.update(entry.workerId, { status, completedAt, error, timeoutHandle: null });
  if (wasRunning && entry.abort) {
    try {
      await entry.abort();
    } catch (err) {
      console.warn(`[worker] ${entry.workerId} abort failed:`, err);
    }
  }
}

/** Own all worker runs, including those belonging to evicted chat sessions. */
export class WorkerLifecycle {
  private readonly registries = new Set<WorkerRegistry>();
  private readonly runs = new Set<Promise<void>>();
  private stopPromise?: Promise<void>;
  stopping = false;

  register(registry: WorkerRegistry): void {
    this.registries.add(registry);
  }

  /** Track the entire run, including initialization and completion bookkeeping. */
  track(run: Promise<void>): void {
    this.runs.add(run);
    void run.then(() => this.runs.delete(run), () => this.runs.delete(run));
  }

  /** Freeze dispatch synchronously, then drain before shared resources are closed. */
  stop(graceMs: number, abortMs = 10_000): Promise<void> {
    if (!this.stopPromise) {
      this.stopping = true;
      this.stopPromise = this.drain(graceMs, abortMs);
    }
    return this.stopPromise;
  }

  private async waitForRuns(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled([...this.runs]).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async drain(graceMs: number, abortMs: number): Promise<void> {
    for (const registry of this.registries) {
      for (const entry of registry.list()) {
        if (entry.status === "queued") {
          await stopWorker(registry, entry, "interrupted", "Bryti shut down before this worker started. It was not replayed.");
        }
      }
    }
    if (!await this.waitForRuns(graceMs)) {
      for (const registry of this.registries) {
        for (const entry of registry.list()) {
          if (entry.status === "running") {
            // Track abort too: an uncooperative tool must prevent an in-process restart.
            this.track(stopWorker(registry, entry, "interrupted", "Bryti shutdown grace period expired. It was not replayed."));
          }
        }
      }
      if (!await this.waitForRuns(abortMs)) {
        throw new Error("Workers did not stop after abort; refusing an in-process restart");
      }
    }
    this.registries.clear();
  }
}
