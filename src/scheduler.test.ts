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

const cronMockState = vi.hoisted(() => ({
  callbacks: new Map<string, Array<() => Promise<void>>>(),
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
        return new Date(base.getTime() + 60_000);
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

  it("notifies once when a recurring occurrence is blocked, without replaying uncertain actions", async () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const workStore = createWorkStore(tempDir);
    const onMessage = vi.fn().mockResolvedValue(true);
    const id = addDueProjection(config, { summary: "Paused schedule", resolved_when: dueWhen(), resolution: "exact", recurrence: "0 8 * * *" });
    const scheduler = createScheduler(config, onMessage, workStore);
    scheduler.start();
    await runExactCallback();
    const store = createProjectionStore("12345", tempDir);
    const workId = store.getById(id)!.delivery_work_id!;
    const when = store.getById(id)!.resolved_when;
    workStore.claim([workId]);
    workStore.finish([workId], "interrupted");
    await runExactCallback();
    await runExactCallback();
    expect(onMessage.mock.calls.filter(([msg]) => msg.workId === `blocked:${workId}`)).toHaveLength(1);
    expect(onMessage.mock.calls.find(([msg]) => msg.workId === `blocked:${workId}`)?.[0].text).toContain("recurring schedule is paused");
    expect(store.getById(id)).toMatchObject({ status: "pending", resolved_when: when, delivery_work_id: workId });
    store.close();
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
    expect(onMessage.mock.calls.some(([msg]) => msg.workId === `blocked:${workId}`)).toBe(true);
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
