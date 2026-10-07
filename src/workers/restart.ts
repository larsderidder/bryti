import type { Config } from "../config.js";
import { createMemoryStore } from "../memory/store.js";
import { createProjectionStore } from "../projection/store.js";
import { isTargetAllowed } from "../scheduler.js";
import { WorkerLifecycle } from "./lifecycle.js";
import { createWorkerRegistry } from "./registry.js";
import { withWorkerStore } from "./store.js";
import { createWorkerTools } from "./tools.js";

/** Restore only accepted work that never started, under current destination permissions. */
export function restoreQueuedWorkers(config: Config, lifecycle: WorkerLifecycle): void {
  const queued = withWorkerStore(config.data_dir, (store) => store.list().filter((receipt) => receipt.status === "queued"));
  lifecycle.queuePaused = true;
  try {
    for (const receipt of queued) {
      const owner = receipt.spec.owner;
      if (lifecycle.hasWorker(receipt.workerId)) {
        continue;
      }
      if (!owner || !config.agent_def.tool_groups.includes("workers") || !isTargetAllowed(config, owner)) {
        withWorkerStore(config.data_dir, (store) => store.finish(receipt.workerId, "failed", "Worker destination or tools are no longer authorized"));
        continue;
      }
      const memory = createMemoryStore(owner.userId, config.data_dir);
      const projections = createProjectionStore(owner.userId, config.data_dir);
      lifecycle.retain(() => { memory.close(); projections.close(); });
      createWorkerTools(config, memory, createWorkerRegistry(), false, projections, undefined,
        () => owner, lifecycle, () => owner);
    }
  } finally {
    lifecycle.queuePaused = false;
    lifecycle.drainQueues();
  }
}
