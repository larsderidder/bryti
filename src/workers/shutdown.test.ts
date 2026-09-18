import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import { createWorkerTools } from "./tools.js";
import { createWorkerRegistry } from "./registry.js";
import { WorkerLifecycle } from "./lifecycle.js";
import { spawnWorkerSession } from "./spawn.js";
import { acknowledgeWorkerEvent, collectWorkerEvents, writeWorkerStatus } from "./recovery.js";

vi.mock("./spawn.js", async (importActual) => ({
  ...await importActual<typeof import("./spawn.js")>(),
  spawnWorkerSession: vi.fn(),
}));
vi.mock("../memory/embeddings.js", () => ({ embed: vi.fn().mockResolvedValue(null) }));

describe("worker tools during shutdown", () => {
  let dir: string;
  let finish: () => void;
  let lifecycle: WorkerLifecycle;
  let registry: ReturnType<typeof createWorkerRegistry>;
  let tools: ReturnType<typeof createWorkerTools>;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-worker-drain-"));
    lifecycle = new WorkerLifecycle();
    registry = createWorkerRegistry();
    const config = {
      data_dir: dir, agent: { model: "test/model" },
      tools: { workers: { max_concurrent: 1 } },
    } as Config;
    tools = createWorkerTools(config, { addFact: vi.fn() } as unknown as MemoryStore, registry,
      false, undefined, undefined,
      () => ({ userId: "u", channelId: "chat", platform: "telegram" }), lifecycle);
    vi.mocked(spawnWorkerSession).mockImplementation(async ({ workerDir, workerId }) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      fs.writeFileSync(path.join(workerDir, "result.md"), "Finished research");
      registry.update(workerId, { status: "complete", completedAt: new Date() });
      writeWorkerStatus(workerDir, { worker_id: workerId, status: "complete" });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function dispatch(task: string) {
    return tools.find((tool) => tool.name === "worker_dispatch")!.execute("test", { task, tools: [] });
  }

  it("freezes dispatch and queue draining while a running worker finishes", async () => {
    await dispatch("first");
    await dispatch("queued");
    const stop = lifecycle.stop(1000);
    const rejected = await dispatch("too late");
    expect(JSON.stringify(rejected)).toContain("shutting down");
    finish();
    await stop;
    expect(spawnWorkerSession).toHaveBeenCalledOnce();
    expect(registry.list().map((entry) => entry.status)).toEqual(["complete", "interrupted"]);
    const events = collectWorkerEvents(dir, true);
    expect(events).toHaveLength(2);
    for (const event of events) {
      acknowledgeWorkerEvent(dir, event.workId!);
    }
    expect(collectWorkerEvents(dir, true)).toEqual([]);
  });

  it("retains cancelled queued work across shutdown and repeated recovery", async () => {
    await dispatch("first");
    await dispatch("cancel this");
    const queued = registry.nextQueued()!;
    await tools.find((tool) => tool.name === "worker_interrupt")!.execute("test", { worker_id: queued.workerId });
    const stop = lifecycle.stop(1000);
    finish();
    await stop;
    const first = collectWorkerEvents(dir, true);
    expect(collectWorkerEvents(dir, true)).toEqual(first);
    expect(first.some((event) => event.workId === `worker:${queued.workerId}:cancelled`)).toBe(true);
    expect(spawnWorkerSession).toHaveBeenCalledOnce();
  });
});
