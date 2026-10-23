import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createScheduler, getSchedulerTargets, groupDueByTarget, scheduledWorkId } from "./scheduler.js";
import type { Config } from "./config.js";
import { PERSONAL_ASSISTANT_DEFAULTS } from "./config.js";
import type { IncomingMessage } from "./channels/types.js";
import { createProjectionStore, type Projection } from "./projection/index.js";
import { createWorkStore, type WorkStore } from "./work/store.js";
import { createCommandStore } from "./work/commands.js";
import { workRecoveryId } from "./work/recovery-event.js";

import { wrapToolWithTrustCheck } from "./trust/wrapper.js";
import { createTrustStore } from "./trust/store.js";
import { Type } from "typebox";
const cronMockState = vi.hoisted(() => ({
  callbacks: new Map<string, Array<() => Promise<void>>>(),
  nextOffsetMs: 60_000,
}));

vi.mock("croner", () => {
  const Cron = vi.fn(function (this: unknown, expr: string, callbackOrOptions?: unknown) {
    if (typeof callbackOrOptions === "function") {
      const callbacks = cronMockState.callbacks.get(expr) ?? [];
      callbacks.push(callbackOrOptions as () => Promise<void>);
      cronMockState.callbacks.set(expr, callbacks);
    }
    return {
      nextRun(after?: Date) {
        const base = after ?? new Date();
        return new Date(base.getTime() + cronMockState.nextOffsetMs);
      },
      stop: vi.fn(),
    };
  });
  return { Cron };
});

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bryti-scheduler-test-"));
}

function makeConfig(cron: Config["cron"] = []): Config {
  return {
    agent: {
      name: "TestBot",
      system_prompt: "test",
      model: "test/model",
      fallback_models: [],
      timezone: "UTC",
    },
    telegram: { token: "tok", allowed_users: [12345] },
    whatsapp: { enabled: false, allowed_users: [] },
    threema: {
      enabled: false,
      gateway_id: "",
      secret: "",
      private_key_path: "",
      allowed_senders: [],
      api_base_url: "https://msgapi.threema.ch",
      callback: { host: "127.0.0.1", port: 8787, path: "/threema/callback" },
    },
    web_e2ee: {
      enabled: false,
      listen_host: "127.0.0.1",
      listen_port: 8787,
      public_origin: "https://example.test",
      allowed_origins: ["https://example.test"],
      path_prefix: "/",
      pairing: { invite_ttl_minutes: 10 },
    },
    models: { providers: [] },
    tools: {
      web_search: { enabled: false, searxng_url: "" },
      fetch_url: { enabled: false, timeout_ms: 5000, backend: "readability", require_https: true },
      workers: { max_concurrent: 1, types: {} },
    },
    integrations: {},
    cron,
    trust: { approved_tools: [] },
    agent_def: { ...PERSONAL_ASSISTANT_DEFAULTS },
    data_dir: "/tmp",
  } as unknown as Config;
}

function dueWhen(minutesOffset = 0): string {
  return new Date(Date.now() + minutesOffset * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

function baseProjection(overrides: Partial<Projection> = {}): Projection {
  return {
    id: "p",
    summary: "Reminder",
    raw_when: null,
    resolved_when: "2026-02-19 10:00",
    resolution: "exact",
    recurrence: null,
    trigger_on_fact: null,
    context: null,
    linked_ids: [],
    target_user_id: null,
    target_channel_id: null,
    target_platform: null,
    target_thread_id: null,
    target_channel_thread_id: null,
    delivery_work_id: null,
    status: "pending",
    created_at: "2026-02-19 09:00",
    resolved_at: null,
    ...overrides,
  };
}

async function runExactCallback(): Promise<void> {
  const callback = cronMockState.callbacks.get("*/5 * * * *")?.[0];
  expect(callback).toBeDefined();
  await callback!();
}

function addDueProjection(config: Config, params: Parameters<ReturnType<typeof createProjectionStore>["add"]>[0]): string {
  const store = createProjectionStore("12345", config.data_dir);
  try {
    return store.add(params);
  } finally {
    store.close();
  }
}

describe("Scheduler", () => {
  let tempDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = makeTempDir();
    cronMockState.callbacks.clear();
    cronMockState.nextOffsetMs = 60_000;
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts and stops without error when config has no cron jobs", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it("runs config cron with a real configured user target", async () => {
    const config = {
      ...makeConfig([{ schedule: "0 8 * * *", message: "config job" }]),
      data_dir: tempDir,
      agent_def: { ...PERSONAL_ASSISTANT_DEFAULTS, memory: { ...PERSONAL_ASSISTANT_DEFAULTS.memory, daily_review: false } },
    } as Config;
    const onMessage = vi.fn().mockResolvedValue(true);
    const scheduler = createScheduler(config, onMessage);
    scheduler.start();

    const callback = cronMockState.callbacks.get("0 8 * * *")?.[0];
    expect(callback).toBeDefined();
    await callback!();

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "12345",
      userId: "12345",
      platform: "telegram",
      text: "config job",
    }));
    scheduler.stop();
  });

  it("discovers active web_e2ee paired devices as scheduler targets", () => {
    const config = {
      ...makeConfig(),
      telegram: { token: "", allowed_users: [] },
      web_e2ee: { ...makeConfig().web_e2ee, enabled: true },
      data_dir: tempDir,
    } as Config;
    fs.mkdirSync(path.join(tempDir, "web-e2ee"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "web-e2ee", "paired-devices.json"), JSON.stringify({
      version: 1,
      devices: [
        {
          deviceId: "wed_active",
          label: "Browser",
          publicKeyJwk: { kty: "OKP", crv: "X25519", x: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          publicKeyFingerprint: "fp-active",
          pairedAt: new Date().toISOString(),
          lastSeenAt: null,
          status: "active",
          notes: "",
          lastInboundCounter: 0,
          lastOutboundCounter: 0,
        },
        {
          deviceId: "wed_revoked",
          label: "Old Browser",
          publicKeyJwk: { kty: "OKP", crv: "X25519", x: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
          publicKeyFingerprint: "fp-revoked",
          pairedAt: new Date().toISOString(),
          lastSeenAt: null,
          status: "revoked",
          notes: "",
          lastInboundCounter: 0,
          lastOutboundCounter: 0,
        },
      ],
    }), "utf-8");

    expect(getSchedulerTargets(config)).toEqual([
      { userId: "wed_active", channelId: "wed_active", platform: "web_e2ee" },
    ]);
  });

  it("groups due projections by stored target instead of broadcasting to every target", () => {
    const fallback = { userId: "legacy", channelId: "telegram-chat", platform: "telegram" as const };
    const grouped = groupDueByTarget([
      baseProjection({ id: "stored", target_user_id: "wed_active", target_channel_id: "wed_active", target_platform: "web_e2ee" }),
      baseProjection({ id: "legacy" }),
    ], fallback);

    expect([...grouped.values()].map((entry) => entry.target)).toEqual([
      { userId: "wed_active", channelId: "wed_active", platform: "web_e2ee" },
      fallback,
    ]);
    expect([...grouped.values()].map((entry) => entry.projections.map((p) => p.id))).toEqual([["stored"], ["legacy"]]);
  });

  it("marks accepted projection occurrences and settles only after completed receipt", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const onMessage = vi.fn().mockResolvedValue(true);
    const id = addDueProjection(config, {
      summary: "Pay invoice",
      resolved_when: dueWhen(),
      resolution: "exact",
      target: { userId: "12345", channelId: "12345", platform: "telegram" },
    });
    const scheduler = createScheduler(config, onMessage, workStore);
    scheduler.start();

    await runExactCallback();

    const storeAfterAccept = createProjectionStore("12345", tempDir);
    const accepted = storeAfterAccept.getById(id)!;
    const workId = scheduledWorkId("12345", accepted);
    expect(accepted.delivery_work_id).toBe(workId);
    expect(storeAfterAccept.getExactDue(5).map((p) => p.id)).not.toContain(id);
    storeAfterAccept.close();

    workStore.claim([workId]);
    workStore.finish([workId], "completed");
    await runExactCallback();

    const storeAfterReceipt = createProjectionStore("12345", tempDir);
    expect(storeAfterReceipt.getById(id)?.status).toBe("passed");
    storeAfterReceipt.close();
    scheduler.stop();
    workStore.close();
  });

  it("leaves enqueue rejections eligible for the same occurrence", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const onMessage = vi.fn().mockResolvedValue(false);
    const id = addDueProjection(config, {
      summary: "Rejected reminder",
      resolved_when: dueWhen(),
      resolution: "exact",
    });
    const scheduler = createScheduler(config, onMessage);
    scheduler.start();

    await runExactCallback();

    const store = createProjectionStore("12345", tempDir);
    expect(store.getById(id)?.delivery_work_id).toBeNull();
    expect(store.getExactDue(5).map((p) => p.id)).toContain(id);
    store.close();
    scheduler.stop();
  });


  it("recovers accepted work links before stale exact projections expire", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const id = addDueProjection(config, {
      summary: "Crashed after enqueue",
      resolved_when: dueWhen(-120),
      resolution: "exact",
    });
    const projection = baseProjection({ id, resolved_when: dueWhen(-120) });
    const workId = scheduledWorkId("12345", projection);
    workStore.accept({
      channelId: "12345",
      userId: "12345",
      text: "queued before crash",
      platform: "telegram",
      workId,
      raw: { type: "projection_exact_check" },
    });
    const scheduler = createScheduler(config, vi.fn(), workStore);
    scheduler.start();

    await runExactCallback();

    const store = createProjectionStore("12345", tempDir);
    expect(store.getById(id)).toMatchObject({ status: "pending", delivery_work_id: workId });
    store.close();
    scheduler.stop();
    workStore.close();
  });

  it("keeps accepted unknown delivery visible and does not enqueue it again", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const onMessage = vi.fn().mockResolvedValue(true);
    const id = addDueProjection(config, {
      summary: "Unknown delivery",
      resolved_when: dueWhen(),
      resolution: "exact",
    });
    const scheduler = createScheduler(config, onMessage, workStore);
    scheduler.start();

    await runExactCallback();
    const storeAfterAccept = createProjectionStore("12345", tempDir);
    const workId = storeAfterAccept.getById(id)!.delivery_work_id!;
    storeAfterAccept.close();
    workStore.recordDelivery([workId], "unknown");
    await runExactCallback();

    const store = createProjectionStore("12345", tempDir);
    expect(onMessage.mock.calls.filter(([msg]) => msg.workId === workId)).toHaveLength(1);
    expect(store.getById(id)).toMatchObject({ status: "pending", delivery_work_id: workId });
    store.close();
    scheduler.stop();
    workStore.close();
  });

  it("a deferred action does not block independent work or the next recurring occurrence", async () => {
    cronMockState.nextOffsetMs = 24 * 60 * 60 * 1000;
    const config = { ...makeConfig(), data_dir: tempDir };
    const work = createWorkStore(tempDir);
    const approvals = vi.fn(() => new Promise<never>(() => {}));
    const executed = vi.fn(async () => ({ content: [{ type: "text" as const, text: "checked" }] }));
    const evaluate = vi.fn().mockResolvedValueOnce({ verdict: "ASK", reason: "publication needs authorization" })
      .mockResolvedValue({ verdict: "ALLOW", reason: "routine read" });
    const onMessage = vi.fn(async (message: IncomingMessage) => {
      const record = work.accept(message).record;
      work.claim([record.id]);
      const tool = wrapToolWithTrustCheck({ name: "integration", label: "Integration", description: "Read or publish",
        parameters: Type.Object({}), execute: executed }, createTrustStore(tempDir), message.userId, {
        config, getLastUserMessage: () => "Unrelated conversation",
        getActiveTask: () => ({ source: "projection_exact_check", request: message.text }),
        source: { source: "automation", automationId: record.id }, evaluateToolCall: evaluate, onApprovalNeeded: approvals,
      }, { level: "elevated" });
      expect((await tool.execute("publish", {})).details).toMatchObject({ approval: "deferred", executed: false });
      await tool.execute("read", {});
      work.recordResponse([record.id], "delivered");
      return true;
    });
    const id = addDueProjection(config, { summary: "Daily checks", resolved_when: dueWhen(), resolution: "exact", recurrence: "0 8 * * *" });
    const scheduler = createScheduler(config, onMessage, work);
    const store = createProjectionStore("12345", tempDir);
    try {
      scheduler.start();
      await runExactCallback();
      const workId = store.getById(id)!.delivery_work_id!;
      await runExactCallback();

      expect(executed).toHaveBeenCalledOnce();
      expect(approvals).not.toHaveBeenCalled();
      expect(work.get(workId)?.execution).toBe("completed");
      expect(store.getById(id)?.delivery_work_id).toBeNull();
      expect(store.getById(id)?.resolved_when! > dueWhen()).toBe(true);
      expect(work.get(workRecoveryId(workId))).toBeNull();
      expect(onMessage).toHaveBeenCalledOnce();
    } finally {
      store.close();
      scheduler.stop();
      work.close();
    }
  });

  it("holds a recurring schedule until managed work has a completed reconciliation", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const commands = createCommandStore(tempDir);
    const onMessage = vi.fn().mockResolvedValue(true);
    const scheduler = createScheduler(config, onMessage, workStore);
    const id = addDueProjection(config, { summary: "Develop", resolved_when: dueWhen(), resolution: "exact", recurrence: "0 10 * * *" });
    scheduler.start();
    await runExactCallback();
    const store = createProjectionStore("12345", tempDir);
    const workId = store.getById(id)!.delivery_work_id!;
    const when = store.getById(id)!.resolved_when;
    const parent = workStore.get(workId)!.message;
    workStore.claim([workId]);
    const command = commands.accept(parent, "call", { command: "true", cwd: tempDir, timeoutSeconds: 60 }, 1);
    workStore.recordResponse([workId], "delivered");
    await runExactCallback();
    expect(store.getById(id)).toMatchObject({ resolved_when: when, delivery_work_id: workId });
    commands.claim(command.id, process.pid, "identity");
    commands.finish(command.id, "complete", 0);
    await runExactCallback();
    expect(store.getById(id)!.delivery_work_id).toBe(workId);
    const review = workStore.accept(commands.collectEvents()[0]).record;
    workStore.claim([review.id]);
    commands.reconcile(workId, review.message, "Actual diff and release checks reviewed", workStore);
    await runExactCallback();
    expect(store.getById(id)!.delivery_work_id).toBe(workId);
    workStore.recordResponse([review.id], "delivered");
    await runExactCallback();
    expect(store.getById(id)!.resolved_when).not.toBe(when);
    store.close();
    commands.close();
    scheduler.stop();
    workStore.close();
  });

  it("recovers an interrupted occurrence after review without replaying it", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const commands = createCommandStore(tempDir);
    const onMessage = vi.fn().mockResolvedValue(true);
    const scheduler = createScheduler(config, onMessage, workStore);
    const id = addDueProjection(config, { summary: "Develop", resolved_when: dueWhen(), resolution: "exact", recurrence: "0 10 * * *" });
    scheduler.start();
    await runExactCallback();
    const store = createProjectionStore("12345", tempDir);
    const workId = store.getById(id)!.delivery_work_id!;
    const when = store.getById(id)!.resolved_when;
    const parent = workStore.get(workId)!.message;
    workStore.claim([workId]);
    const command = commands.accept(parent, "call", { command: "true", cwd: tempDir, timeoutSeconds: 60 }, 1);
    workStore.finish([workId], "interrupted");
    commands.claim(command.id, process.pid, "identity");
    commands.finish(command.id, "complete", 0);
    const review = workStore.accept(commands.collectEvents()[0]).record;
    workStore.claim([review.id]);
    commands.reconcile(workId, review.message, "No deployment; preserved local changes reviewed", workStore);
    workStore.recordResponse([review.id], "delivered");
    await runExactCallback();
    expect(store.getById(id)!.resolved_when).not.toBe(when);
    expect(onMessage.mock.calls.filter(([msg]) => msg.workId === workId)).toHaveLength(1);
    expect(workStore.get(workId)!.execution).toBe("interrupted");
    store.close();
    commands.close();
    scheduler.stop();
    workStore.close();
  });

  it("bounds oversized reminders without discarding the stored instructions", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const onMessage = vi.fn().mockResolvedValue(true);
    const context = "Historical instructions and constraints. ".repeat(500);
    const id = addDueProjection(config, { summary: "Morning check", context, resolved_when: dueWhen(), resolution: "exact" });
    const scheduler = createScheduler(config, onMessage);
    scheduler.start();
    await runExactCallback();
    const message = onMessage.mock.calls[0][0] as IncomingMessage;
    expect(message.text.length).toBeLessThanOrEqual(8000);
    expect(message.text).toContain("projection_read");
    expect(message.text).toContain(id);
    expect(message.text).toMatch(/before.*act/i);
    const store = createProjectionStore("12345", tempDir);
    expect(store.getById(id)?.context).toBe(context);
    store.close();
    scheduler.stop();
  });

  it("asks the agent to review missing reconciliation after a successful delivered answer", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const commands = createCommandStore(tempDir);
    const onMessage = vi.fn().mockResolvedValue(true);
    const id = addDueProjection(config, { summary: "Health check", resolved_when: dueWhen(), resolution: "exact", recurrence: "0 8 * * *" });
    const scheduler = createScheduler(config, onMessage, workStore);
    scheduler.start();
    await runExactCallback();
    const store = createProjectionStore("12345", tempDir);
    const workId = store.getById(id)!.delivery_work_id!;
    workStore.claim([workId]);
    const command = commands.accept(workStore.get(workId)!.message, "call", { command: "true", cwd: tempDir, timeoutSeconds: 60 }, 1);
    commands.finish(command.id, "complete", 0);
    workStore.recordResponse([workId], "delivered");
    await runExactCallback();
    expect(workStore.get(workRecoveryId(workId))).toBeNull();
    const completion = workStore.accept(commands.collectEvents()[0]).record;
    workStore.claim([completion.id]);
    await runExactCallback();
    expect(workStore.get(workRecoveryId(workId))).toBeNull();
    workStore.recordResponse([completion.id], "delivered");
    await runExactCallback();
    const review = onMessage.mock.calls.find(([msg]) => msg.workId === workRecoveryId(workId))?.[0];
    expect(review).toMatchObject({ raw: { type: "work_recovery" }, userId: "12345", platform: "telegram" });
    expect(review?.text).toContain("work_inspect");
    expect(review?.text).toContain("work_reconcile");
    expect(review?.text).toContain("NOOP");
    expect(onMessage.mock.calls.some(([msg]) => msg.raw.type === "recovery_notice")).toBe(false);
    expect(store.getById(id)?.delivery_work_id).toBe(workId);
    store.close();
    commands.close();
    scheduler.stop();
    workStore.close();
  });

  it("recovers failed no-command occurrences after a successful review, skipping missed slots", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const commands = createCommandStore(tempDir);
    const onMessage = vi.fn().mockResolvedValue(true);
    const id = addDueProjection(config, { summary: "Calendar", resolved_when: dueWhen(), resolution: "exact", recurrence: "0 8 * * *" });
    const scheduler = createScheduler(config, onMessage, workStore);
    scheduler.start();
    await runExactCallback();
    const store = createProjectionStore("12345", tempDir);
    const workId = store.getById(id)!.delivery_work_id!;
    workStore.claim([workId]);
    workStore.finish([workId], "failed", "Input exceeds the message limit");
    const review = workStore.accept({ ...workStore.get(workId)!.message, workId: "owner-review", text: "Resume future checks", raw: null }).record;
    workStore.claim([review.id]);
    commands.reconcile(workId, review.message, "Rejected before execution; no actions performed", workStore);
    workStore.recordResponse([review.id], "delivered");
    await runExactCallback();
    expect(store.getById(id)?.delivery_work_id).not.toBe(workId);
    expect(store.getById(id)!.resolved_when! > dueWhen()).toBe(true);
    expect(workStore.get(workId)?.execution).toBe("failed");
    expect(onMessage.mock.calls.filter(([msg]) => msg.workId === workId)).toHaveLength(1);
    store.close();
    commands.close();
    scheduler.stop();
    workStore.close();
  });

  it.each(["completed", "failed", "interrupted"] as const)("does not repeat a %s recovery attempt across days and restarts", async (outcome) => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const onMessage = vi.fn().mockResolvedValue(true);
    const id = addDueProjection(config, { summary: "Paused", resolved_when: dueWhen(), resolution: "exact", recurrence: "0 8 * * *" });
    let scheduler = createScheduler(config, onMessage, workStore);
    scheduler.start();
    await runExactCallback();
    const store = createProjectionStore("12345", tempDir);
    const workId = store.getById(id)!.delivery_work_id!;
    workStore.claim([workId]);
    workStore.finish([workId], "interrupted");
    const baseTime = Date.now();
    try {
      // Previously delivered human notices must not suppress the new agent review.
      const legacy = workStore.accept({ ...workStore.get(workId)!.message, workId: `recovery:${workId}`, raw: { type: "recovery_notice" } }).record;
      workStore.claim([legacy.id]);
      workStore.recordResponse([legacy.id], "delivered");
      await runExactCallback();
      const reviewId = workRecoveryId(workId);
      expect(workStore.get(reviewId)?.execution).toBe("queued");
      await runExactCallback();
      workStore.claim([reviewId]);
      workStore.finish([reviewId], outcome);
      vi.useFakeTimers();
      vi.setSystemTime(baseTime + 24 * 60 * 60 * 1000);
      await runExactCallback();
      scheduler.stop();
      cronMockState.callbacks.clear();
      scheduler = createScheduler(config, onMessage, workStore);
      scheduler.start();
      await runExactCallback();
      expect(onMessage.mock.calls.filter(([msg]) => msg.workId === reviewId)).toHaveLength(1);
      expect(store.getById(id)?.delivery_work_id).toBe(workId);
    } finally {
      vi.useRealTimers();
      store.close();
      scheduler.stop();
      workStore.close();
    }
  });

  it.each(["queued", "completed", "failed", "interrupted"] as const)("preserves an accepted %s agent review from the original namespace", async (status) => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const onMessage = vi.fn().mockResolvedValue(true);
    const id = addDueProjection(config, { summary: "Paused", resolved_when: dueWhen(), resolution: "exact" });
    const scheduler = createScheduler(config, onMessage, workStore);
    scheduler.start();
    await runExactCallback();
    const store = createProjectionStore("12345", tempDir);
    const workId = store.getById(id)!.delivery_work_id!;
    workStore.claim([workId]);
    workStore.finish([workId], "interrupted");
    const previous = workStore.accept({ ...workStore.get(workId)!.message,
      workId: `recovery:${workId}`, raw: { type: "work_recovery" } }).record;
    if (status !== "queued") {
      workStore.claim([previous.id]);
      workStore.finish([previous.id], status);
    }
    await runExactCallback();
    expect(onMessage.mock.calls.filter(([msg]) => msg.raw.type === "work_recovery")).toEqual([]);
    expect(workStore.get(workRecoveryId(workId))).toBeNull();
    expect(store.getById(id)?.delivery_work_id).toBe(workId);
    store.close();
    scheduler.stop();
    workStore.close();
  });

  it.each([false, true])("does not let rejected recovery admission prevent healthy settlement (throws=%s)", async (throws) => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const onMessage = vi.fn(async (msg: IncomingMessage) => {
      if (throws && (msg.raw as { type: string }).type === "work_recovery") {
        throw new Error("Recovery admission failed");
      }
      return (msg.raw as { type: string }).type !== "work_recovery";
    });
    const first = addDueProjection(config, { summary: "Failed", resolved_when: dueWhen(), resolution: "exact" });
    const second = addDueProjection(config, { summary: "Healthy", resolved_when: dueWhen(), resolution: "exact" });
    const scheduler = createScheduler(config, onMessage, workStore);
    scheduler.start();
    await runExactCallback();
    const store = createProjectionStore("12345", tempDir);
    const failed = store.getById(first)!.delivery_work_id!;
    const healthy = store.getById(second)!.delivery_work_id!;
    workStore.claim([failed]);
    workStore.finish([failed], "failed");
    workStore.claim([healthy]);
    workStore.recordResponse([healthy], "delivered");
    await runExactCallback();
    expect(store.getById(first)?.delivery_work_id).toBe(failed);
    expect(store.getById(second)?.status).toBe("passed");
    expect(workStore.get(workRecoveryId(failed))).toBeNull();
    await runExactCallback();
    expect(onMessage.mock.calls.filter(([msg]) => msg.workId === workRecoveryId(failed))).toHaveLength(2);
    store.close();
    scheduler.stop();
    workStore.close();
  });
  it("rearms after a silent agent recovery review without replaying the old occurrence", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const commands = createCommandStore(tempDir);
    const onMessage = vi.fn().mockResolvedValue(true);
    const id = addDueProjection(config, { summary: "Calendar", resolved_when: dueWhen(), resolution: "exact", recurrence: "0 8 * * *" });
    const scheduler = createScheduler(config, onMessage, workStore);
    scheduler.start();
    await runExactCallback();
    const store = createProjectionStore("12345", tempDir);
    const workId = store.getById(id)!.delivery_work_id!;
    workStore.claim([workId]);
    workStore.finish([workId], "interrupted");
    await runExactCallback();
    const review = workStore.get(workRecoveryId(workId))!;
    workStore.claim([review.id]);
    commands.reconcile(workId, review.message, "Read-only check stopped; inspected outcomes, no external effects", workStore);
    expect(commands.isReconciled(workId, workStore)).toBe(false);
    workStore.finish([review.id], "completed");
    await runExactCallback();
    expect(store.getById(id)?.delivery_work_id).not.toBe(workId);
    expect(workStore.get(workId)?.execution).toBe("interrupted");
    expect(onMessage.mock.calls.filter(([msg]) => msg.workId === workId)).toHaveLength(1);
    store.close();
    commands.close();
    scheduler.stop();
    workStore.close();
  });

  it("keeps delivery reconciliation after the agent resolves a recurring projection", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const onMessage = vi.fn().mockResolvedValue(true);
    const id = addDueProjection(config, { summary: "Resolved before delivery", resolved_when: dueWhen(), resolution: "exact", recurrence: "0 8 * * *" });
    const scheduler = createScheduler(config, onMessage, workStore);
    scheduler.start();
    await runExactCallback();
    const store = createProjectionStore("12345", tempDir);
    const workId = store.getById(id)!.delivery_work_id!;
    workStore.claim([workId]);
    store.resolve(id, "done");
    workStore.recordResponse([workId], "unknown");
    await runExactCallback();
    expect(onMessage.mock.calls.some(([msg]) => msg.workId === workRecoveryId(workId))).toBe(false);
    workStore.recordResponse([workId], "delivered");
    await runExactCallback();
    expect(store.getById(id)).toMatchObject({ status: "done", delivery_work_id: null });
    store.close();
    scheduler.stop();
    workStore.close();
  });

  it("fails closed for an invalid stored target instead of falling back", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const onMessage = vi.fn().mockResolvedValue(true);
    const id = addDueProjection(config, {
      summary: "Bad target",
      resolved_when: dueWhen(),
      resolution: "exact",
      target: { userId: "12345", channelId: "web-device", platform: "web_e2ee" },
    });
    const scheduler = createScheduler(config, onMessage);
    scheduler.start();

    await runExactCallback();

    const store = createProjectionStore("12345", tempDir);
    expect(onMessage.mock.calls.some(([msg]) => msg.text.includes(`(id: ${id})`))).toBe(false);
    expect(store.getById(id)).toMatchObject({ status: "pending", delivery_work_id: null });
    store.close();
    scheduler.stop();
  });

  it("does not start projection jobs when no scheduler target is configured", () => {
    const config = {
      ...makeConfig(),
      telegram: { token: "", allowed_users: [] },
      agent_def: { ...PERSONAL_ASSISTANT_DEFAULTS, memory: { ...PERSONAL_ASSISTANT_DEFAULTS.memory, daily_review: false } },
      data_dir: tempDir,
    } as Config;
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    expect(cronMockState.callbacks.get("*/5 * * * *")).toBeUndefined();
    scheduler.stop();
  });
});
