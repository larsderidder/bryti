import type { WorkerEntry, WorkerRegistry, WorkerStatus } from "./registry.js";
import { writeWorkerStatus } from "./recovery.js";
import { withWorkerStore } from "./store.js";
import type { WorkerProgress } from "./tracker.js";

/** Commit the authoritative outcome before exposing it through the registry. */
export function commitWorkerOutcome(
  registry: WorkerRegistry, entry: WorkerEntry, status: WorkerStatus, error: string | null,
  progress?: WorkerProgress, resultHash?: string,
): void {
  let authoritative = false;
  if (entry.dataDir) {
    withWorkerStore(entry.dataDir, (store) => {
      authoritative = Boolean(store.get(entry.workerId));
      store.finish(entry.workerId, status, error, resultHash, progress);
    });
  }
  const completedAt = new Date();
  try {
    writeWorkerStatus(entry.workerDir, {
      worker_id: entry.workerId, status, task: entry.task,
      started_at: entry.startedAt.toISOString(), completed_at: completedAt.toISOString(),
      model: entry.model, error, result_path: entry.resultPath, progress,
    });
  } catch (failure) {
    if (!authoritative) {
      throw failure;
    }
    console.warn("[workers] Derived status could not be written; committed receipt retained");
  }
  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
  }
  registry.update(entry.workerId, { status, completedAt, error, timeoutHandle: null });
}

/** Record stop intent without releasing the slot of an execution still draining. */
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
  if (entry.dataDir) {
    withWorkerStore(entry.dataDir, (store) => store.requestStop(entry.workerId, status, error));
  }
  if (entry.runActive) {
    registry.update(entry.workerId, { status: "stopping", stopStatus: status, error });
    try {
      writeWorkerStatus(entry.workerDir, {
        worker_id: entry.workerId, status: "stopping", stop_status: status,
        task: entry.task, started_at: entry.startedAt.toISOString(), completed_at: null,
        model: entry.model, error, result_path: entry.resultPath,
      });
    } catch {
      console.warn("[workers] Stop intent retained in the worker receipt");
    }
  } else {
    commitWorkerOutcome(registry, entry, status, error);
  }
  if (entry.timeoutHandle) {
    clearTimeout(entry.timeoutHandle);
    registry.update(entry.workerId, { timeoutHandle: null });
  }
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
  private readonly cleanups = new Set<() => void>();
  private readonly queueDrains = new Map<WorkerRegistry, (workerId: string) => void>();
  queuePaused = false;

  addDrain(registry: WorkerRegistry, drain: (workerId: string) => void): void {
    this.queueDrains.set(registry, drain);
  }

  private queuedWorkers(): Array<{ registry: WorkerRegistry; entry: WorkerEntry }> {
    const queued = [...this.queueDrains.keys()].flatMap((registry) =>
      registry.list().filter((entry) => entry.status === "queued").map((entry) => ({ registry, entry })));
    return queued.sort((left, right) => (left.entry.queueOrder ?? left.entry.startedAt.getTime())
      - (right.entry.queueOrder ?? right.entry.startedAt.getTime()));
  }

  queuePosition(workerId: string): number | undefined {
    const index = this.queuedWorkers().findIndex(({ entry }) => entry.workerId === workerId);
    if (index >= 0) {
      return index + 1;
    }
    return undefined;
  }

  /** Select globally by durable acceptance order, not by chat-session registration. */
  drainQueues(): void {
    while (!this.stopping && !this.queuePaused) {
      const next = this.queuedWorkers()[0];
      if (!next) {
        return;
      }
      this.queueDrains.get(next.registry)!(next.entry.workerId);
      if (next.registry.get(next.entry.workerId)?.status === "queued") {
        return;
      }
    }
  }

  /** Keep resources for recovered workers until their application-owned runs settle. */
  retain(cleanup: () => void): void {
    this.cleanups.add(cleanup);
  }

  findWorker(workerId: string): { registry: WorkerRegistry; entry: WorkerEntry } | undefined {
    for (const registry of this.registries) {
      const entry = registry.get(workerId);
      if (entry) {
        return { registry, entry };
      }
    }
    return undefined;
  }

  hasWorker(workerId: string): boolean {
    return Boolean(this.findWorker(workerId));
  }

  runningCount(): number {
    return [...this.registries].reduce((count, registry) => count + registry.runningCount(), 0);
  }

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
    // Accepted but unstarted work remains queued for the next process.
    for (const registry of this.registries) {
      for (const entry of registry.list()) {
        if (entry.status === "queued" && !entry.dataDir) {
          await stopWorker(registry, entry, "interrupted", "Legacy queued work had no durable launch specification.");
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
    this.queueDrains.clear();
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.clear();
  }
}
