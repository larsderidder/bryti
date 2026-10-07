import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { IncomingMessage } from "../channels/types.js";
import type { MemoryStore } from "../memory/store.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkerTools } from "./tools.js";
import { createWorkerRegistry } from "./registry.js";
import { commitWorkerOutcome, stopWorker, WorkerLifecycle } from "./lifecycle.js";
import { spawnWorkerSession } from "./spawn.js";
import { collectWorkerEvents, acknowledgeWorkerEvent } from "./recovery.js";
import { WorkerStore, withWorkerStore, type WorkerLaunchSpec } from "./store.js";
import { recoverWorkerProgress } from "./tracker.js";

vi.mock("./spawn.js", async (importActual) => ({
  ...await importActual<typeof import("./spawn.js")>(), spawnWorkerSession: vi.fn(),
}));
vi.mock("../memory/embeddings.js", () => ({ embed: vi.fn().mockResolvedValue(null) }));

describe("durable worker boundaries", () => {
  let dir: string;
  let config: Config;
  let owner: IncomingMessage;
  let finishes: Array<() => void>;
  let lifecycles: WorkerLifecycle[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-worker-durable-"));
    config = { data_dir: dir, agent: { model: "test/model" },
      tools: { workers: { max_concurrent: 1 } } } as Config;
    owner = { userId: "u", channelId: "chat", channelThreadId: "topic", threadId: "default",
      platform: "telegram", workId: "parent", workIds: ["parent"], text: "", raw: null };
    finishes = [];
    lifecycles = [];
    vi.mocked(spawnWorkerSession).mockImplementation(async ({ registry, workerId }) => {
      registry.update(workerId, { abort: async () => {} });
      await new Promise<void>((resolve) => finishes.push(resolve));
      const entry = registry.get(workerId)!;
      if (entry.status === "running") {
        commitWorkerOutcome(registry, entry, "complete", null, undefined, "result-hash");
      }
    });
  });

  afterEach(async () => {
    for (const lifecycle of lifecycles) {
      lifecycle.stopping = true;
    }
    for (const finish of finishes) {
      finish();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.restoreAllMocks();
    vi.clearAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function tools(registry = createWorkerRegistry(), lifecycle = new WorkerLifecycle(), target = owner) {
    lifecycles.push(lifecycle);
    const result = createWorkerTools(config, { addFact: vi.fn() } as unknown as MemoryStore, registry,
      false, undefined, undefined, () => target, lifecycle, () => target);
    return { registry, lifecycle, tool: (name: string) => result.find((tool) => tool.name === name)! };
  }

  function spec(): WorkerLaunchSpec {
    return { task: "research", toolNames: [], timeoutMs: 60_000, owner, maxTurns: 5 };
  }

  it("deduplicates the same dispatch while retaining independent call identities", async () => {
    const worker = tools();
    const first = await worker.tool("worker_dispatch").execute("call", { task: "research", tools: [] });
    const repeated = await worker.tool("worker_dispatch").execute("call", { task: "research", tools: [] });
    expect(repeated.details).toEqual(first.details);
    await worker.tool("worker_dispatch").execute("another", { task: "research", tools: [] });
    expect(worker.registry.list()).toHaveLength(2);
    expect(spawnWorkerSession).toHaveBeenCalledOnce();
  });

  it("retains the accepted model chain when configuration changes before launch or retry", async () => {
    const worker = tools();
    await worker.tool("worker_dispatch").execute("active", { task: "active", tools: [] });
    const queued = await worker.tool("worker_dispatch").execute("queued", { task: "queued", tools: [] });
    config.agent.model = "new/model";
    config.agent.fallback_models = ["new/fallback"];
    const repeated = await worker.tool("worker_dispatch").execute("queued", { task: "queued", tools: [] });
    expect(repeated.details).toEqual(queued.details);
    finishes[0]();
    await vi.waitFor(() => expect(spawnWorkerSession).toHaveBeenCalledTimes(2));
    expect(vi.mocked(spawnWorkerSession).mock.calls[1][0].modelCandidates).toEqual(["test/model"]);
  });

  it("rejects reuse of a dispatch identity with changed arguments", async () => {
    const worker = tools();
    await worker.tool("worker_dispatch").execute("call", { task: "research", tools: [] });
    const changed = await worker.tool("worker_dispatch").execute("call", { task: "different", tools: [] });
    expect(JSON.stringify(changed)).toContain("different arguments");
    expect(spawnWorkerSession).toHaveBeenCalledOnce();
  });

  it("retains queued acceptance and steering across process recovery", async () => {
    const receipt = withWorkerStore(dir, (store) => store.accept("queued", spec(), "test/model"));
    withWorkerStore(dir, (store) => { store.steer(receipt.workerId, "Use the supplied sources"); store.recover(); });
    const worker = tools();
    expect(spawnWorkerSession).toHaveBeenCalledOnce();
    expect(worker.registry.get(receipt.workerId)?.pendingSteering).toBe("Use the supplied sources");
    expect(withWorkerStore(dir, (store) => store.get(receipt.workerId))?.spec).toEqual(spec());
  });

  it("never starts a queued worker cancelled before restart", async () => {
    const receipt = withWorkerStore(dir, (store) => store.accept("queued", spec(), "test/model"));
    withWorkerStore(dir, (store) => { store.requestStop(receipt.workerId, "cancelled", null); store.finish(receipt.workerId, "cancelled", null); });
    tools();
    expect(spawnWorkerSession).not.toHaveBeenCalled();
    expect(collectWorkerEvents(dir, true)[0].workId).toBe(`worker:${receipt.workerId}:cancelled`);
  });

  it("does not acknowledge success before terminal persistence", () => {
    const receipt = withWorkerStore(dir, (store) => store.accept("running", spec(), "test/model"));
    withWorkerStore(dir, (store) => store.claim(receipt.workerId));
    const registry = createWorkerRegistry();
    const workerDir = path.join(dir, "files", "workers", receipt.workerId);
    fs.mkdirSync(workerDir, { recursive: true });
    const entry = registry.register({ workerId: receipt.workerId, workerDir, resultPath: path.join(workerDir, "result.md"),
      status: "running", task: "research", model: "test/model", startedAt: new Date(), error: null,
      abort: null, timeoutHandle: null, dataDir: dir });
    const fail = vi.spyOn(WorkerStore.prototype, "finish").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => commitWorkerOutcome(registry, entry, "complete", null)).toThrow("disk full");
    expect(entry.status).toBe("running");
    expect(collectWorkerEvents(dir)).toEqual([]);
    fail.mockRestore();
  });

  it("recovers a committed completion even when its derived status file is lost", async () => {
    const worker = tools();
    await worker.tool("worker_dispatch").execute("call", { task: "research", tools: [] });
    const entry = worker.registry.list()[0];
    finishes[0]();
    await vi.waitFor(() => expect(entry.runActive).toBe(false));
    fs.rmSync(path.join(entry.workerDir, "status.json"));
    const events = collectWorkerEvents(dir, true);
    expect(events[0].workId).toBe(`worker:${entry.workerId}:complete`);
    expect(events[0].text).toContain("result-hash");
    acknowledgeWorkerEvent(dir, events[0].workId!);
    expect(collectWorkerEvents(dir, true)).toEqual([]);
  });

  it("holds the concurrency slot until the full cancelled run settles", async () => {
    const worker = tools();
    await worker.tool("worker_dispatch").execute("first", { task: "first", tools: [] });
    await worker.tool("worker_dispatch").execute("queued", { task: "queued", tools: [] });
    const first = worker.registry.list()[0];
    await stopWorker(worker.registry, first, "cancelled", null);
    expect(first.status).toBe("stopping");
    expect(worker.registry.runningCount()).toBe(1);
    expect(collectWorkerEvents(dir)).toEqual([]);
    expect(spawnWorkerSession).toHaveBeenCalledOnce();
    finishes[0]();
    await vi.waitFor(() => expect(spawnWorkerSession).toHaveBeenCalledTimes(2));
    expect(first.status).toBe("cancelled");
  });

  it("shares concurrency slots across conversation tool sets", async () => {
    const lifecycle = new WorkerLifecycle();
    const first = tools(createWorkerRegistry(), lifecycle);
    const second = tools(createWorkerRegistry(), lifecycle, { ...owner, threadId: "other", workId: "other-work", workIds: ["other-work"] });
    await first.tool("worker_dispatch").execute("a", { task: "first", tools: [] });
    await second.tool("worker_dispatch").execute("b", { task: "second", tools: [] });
    expect(spawnWorkerSession).toHaveBeenCalledOnce();
    finishes[0]();
    await vi.waitFor(() => expect(spawnWorkerSession).toHaveBeenCalledTimes(2));
  });

  it("drains different conversation queues in durable acceptance order", async () => {
    const lifecycle = new WorkerLifecycle();
    const first = tools(createWorkerRegistry(), lifecycle);
    const second = tools(createWorkerRegistry(), lifecycle, { ...owner, threadId: "other", workId: "other-work", workIds: ["other-work"] });
    await first.tool("worker_dispatch").execute("active", { task: "active", tools: [] });
    await second.tool("worker_dispatch").execute("older", { task: "older", tools: [] });
    await first.tool("worker_dispatch").execute("newer", { task: "newer", tools: [] });
    finishes[0]();
    await vi.waitFor(() => expect(spawnWorkerSession).toHaveBeenCalledTimes(2));
    expect(vi.mocked(spawnWorkerSession).mock.calls[1][0].task).toBe("older");
  });

  it("retains control of a live worker after its originating chat session was replaced", async () => {
    const lifecycle = new WorkerLifecycle();
    const first = tools(createWorkerRegistry(), lifecycle);
    await first.tool("worker_dispatch").execute("active", { task: "active", tools: [] });
    const entry = first.registry.list()[0];
    const steer = vi.fn().mockResolvedValue(undefined);
    first.registry.update(entry.workerId, { steer });
    const replacement = tools(createWorkerRegistry(), lifecycle);
    expect(replacement.registry.list()).toHaveLength(0);
    await replacement.tool("worker_steer").execute("steer", { worker_id: entry.workerId, guidance: "New guidance" });
    expect(steer).toHaveBeenCalledWith("New guidance");
    await replacement.tool("worker_interrupt").execute("stop", { worker_id: entry.workerId });
    expect(entry.status).toBe("stopping");
    expect(lifecycle.runningCount()).toBe(1);
  });

  it("never starts an accepted worker whose artifact initialization failed", async () => {
    const worker = tools();
    fs.writeFileSync(path.join(dir, "files"), "not a directory");
    const result = await worker.tool("worker_dispatch").execute("call", { task: "research", tools: [] });
    expect(JSON.stringify(result)).toContain("acceptance failed");
    expect(withWorkerStore(dir, (store) => store.list())[0].status).toBe("failed");
    expect(spawnWorkerSession).not.toHaveBeenCalled();
  });

  it("does not continue a worker from an internal automation event", async () => {
    const prior = withWorkerStore(dir, (store) => store.accept("prior", spec(), "test/model"));
    withWorkerStore(dir, (store) => { store.claim(prior.workerId); store.finish(prior.workerId, "interrupted", null); });
    const worker = tools(createWorkerRegistry(), new WorkerLifecycle(), { ...owner, raw: { type: "worker_trigger" } });
    const result = await worker.tool("worker_resume").execute("resume", { worker_id: prior.workerId });
    expect(JSON.stringify(result)).toContain("new user request");
    expect(spawnWorkerSession).not.toHaveBeenCalled();
  });

  it("binds continuation to the originating owner and topic", async () => {
    const prior = withWorkerStore(dir, (store) => store.accept("prior", spec(), "test/model"));
    withWorkerStore(dir, (store) => { store.claim(prior.workerId); store.finish(prior.workerId, "interrupted", null); });
    const other = tools(createWorkerRegistry(), new WorkerLifecycle(), { ...owner, channelThreadId: "other-topic" });
    const denied = await other.tool("worker_resume").execute("resume", { worker_id: prior.workerId });
    expect(JSON.stringify(denied)).toContain("unavailable");
    expect(spawnWorkerSession).not.toHaveBeenCalled();
  });

  it("continues the same private conversation without resetting its deadline", async () => {
    const prior = withWorkerStore(dir, (store) => store.accept("prior", spec(), "test/model"));
    const claimed = withWorkerStore(dir, (store) => store.claim(prior.workerId))!;
    withWorkerStore(dir, (store) => store.finish(prior.workerId, "interrupted", null));
    const worker = tools();
    const result = await worker.tool("worker_resume").execute("resume", { worker_id: prior.workerId });
    const id = (result.details as { worker_id: string }).worker_id;
    const resumed = withWorkerStore(dir, (store) => store.get(id))!;
    expect(resumed.sessionId).toBe(prior.sessionId);
    expect(resumed.deadlineAt).toBe(claimed.deadlineAt);
    expect(spawnWorkerSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: prior.sessionId }));
  });

  it("retains accepted steering until its actual user entry is committed", () => {
    const receipt = withWorkerStore(dir, (store) => store.accept("queued", spec(), "test/model"));
    withWorkerStore(dir, (store) => {
      store.steer(receipt.workerId, "New guidance");
      store.confirmSteering(receipt.workerId, "Old guidance", Date.now());
      expect(store.get(receipt.workerId)?.pendingSteering).toBe("New guidance");
      store.confirmSteering(receipt.workerId, "New guidance", Date.now());
      expect(store.get(receipt.workerId)?.pendingSteering).toBeNull();
    });
  });

  it("does not confuse old identical steering with a newly accepted instruction", () => {
    const prior = withWorkerStore(dir, (store) => store.accept("prior", spec(), "test/model"));
    withWorkerStore(dir, (store) => {
      store.claim(prior.workerId);
      store.steer(prior.workerId, "Same guidance");
      store.finish(prior.workerId, "interrupted", null);
      const original = store.get(prior.workerId)!;
      const resumed = store.accept("resume", spec(), "test/model", original);
      store.confirmSteering(resumed.workerId, "Same guidance", original.steeringAcceptedAt! - 1);
      expect(store.get(resumed.workerId)?.pendingSteering).toBe("Same guidance");
      store.confirmSteering(resumed.workerId, "Same guidance", original.steeringAcceptedAt!);
      expect(store.get(resumed.workerId)?.pendingSteering).toBeNull();
    });
  });

  it("recovers prior fetched evidence and consumed turns from persisted SDK entries", () => {
    const sessionDir = path.join(dir, "work", "worker-sessions", "w-12345678");
    const manager = SessionManager.create(dir, sessionDir);
    manager.appendMessage({ role: "user", content: "research", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fetch", name: "fetch_url", arguments: { url: "https://example.com" } }],
      api: "anthropic-messages", provider: "test", model: "model", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    manager.appendMessage({ role: "toolResult", toolCallId: "fetch", toolName: "fetch_url", isError: false,
      content: [{ type: "text", text: "Retained source evidence" }], timestamp: Date.now() });
    const reopened = SessionManager.continueRecent(dir, sessionDir);
    expect(reopened.buildSessionContext().messages.some((message) => message.role === "toolResult")).toBe(true);
    const progress = recoverWorkerProgress(reopened.getBranch());
    expect(progress.turns_completed).toBe(1);
    expect(progress.tool_calls_by_name.fetch_url).toBe(1);
  });
});
