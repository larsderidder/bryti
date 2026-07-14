import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { createScheduler, getSchedulerTargets, groupDueByTarget } from "./scheduler.js";
import type { Config } from "./config.js";
import { PERSONAL_ASSISTANT_DEFAULTS } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync("/tmp/bryti-scheduler-test-");
}

function makeConfig(cron: Config["cron"] = []): Config {
  return {
    agent: {
      name: "TestBot",
      system_prompt: "test",
      model: "test/model",
      fallback_models: [],
    },
    telegram: { token: "tok", allowed_users: [12345] },
    whatsapp: { enabled: false, allowed_users: [] },
    threema: { enabled: false, gateway_id: "", secret: "", private_key_path: "", allowed_senders: [], api_base_url: "https://msgapi.threema.ch", callback: { host: "127.0.0.1", port: 8787, path: "/threema/callback" } },
    web_e2ee: { enabled: false, listen_host: "127.0.0.1", listen_port: 8787, public_origin: "https://example.test", allowed_origins: ["https://example.test"], path_prefix: "/", pairing: { invite_ttl_minutes: 10 } },
    models: { providers: [] },
    tools: {
      web_search: { enabled: false, searxng_url: "" },
      fetch_url: { enabled: false, timeout_ms: 5000, backend: "readability", require_https: true },
    },
    cron,
    agent_def: { ...PERSONAL_ASSISTANT_DEFAULTS },
    data_dir: "/tmp",
  } as Config;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Scheduler", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts and stops without error when config has no cron jobs", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const scheduler = createScheduler(config, vi.fn());
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it("starts config-driven cron jobs", () => {
    const config = {
      ...makeConfig([{ schedule: "0 8 * * *", message: "config job" }]),
      data_dir: tempDir,
    };
    const scheduler = createScheduler(config, vi.fn());
    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
  });

  it("starts projection jobs when a primary user is configured", () => {
    const config = { ...makeConfig(), data_dir: tempDir };
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    const logs = consoleSpy.mock.calls.map((c) => c[0]);
    expect(logs.some((l: string) => l.includes("Bootstrapped daily review projection"))).toBe(true);
    expect(logs.some((l: string) => l.includes("Exact-time check scheduled every 5 minutes"))).toBe(true);

    scheduler.stop();
    consoleSpy.mockRestore();
  });


  it("discovers active web_e2ee paired devices as scheduler targets", () => {
    const config = {
      ...makeConfig(),
      telegram: { token: "", allowed_users: [] },
      web_e2ee: { ...makeConfig().web_e2ee, enabled: true },
      data_dir: tempDir,
    } as Config;
    fs.mkdirSync(`${tempDir}/web-e2ee`, { recursive: true });
    fs.writeFileSync(`${tempDir}/web-e2ee/paired-devices.json`, JSON.stringify({
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
    const base = {
      id: "p",
      summary: "Reminder",
      raw_when: null,
      resolved_when: "2026-02-19 10:00",
      resolution: "exact" as const,
      recurrence: null,
      trigger_on_fact: null,
      context: null,
      linked_ids: [],
      status: "pending" as const,
      created_at: "2026-02-19 09:00",
      resolved_at: null,
    };

    const grouped = groupDueByTarget([
      { ...base, id: "stored", target_user_id: "wed_active", target_channel_id: "wed_active", target_platform: "web_e2ee" },
      { ...base, id: "legacy", target_user_id: null, target_channel_id: null, target_platform: null },
    ], fallback);

    expect([...grouped.values()].map((entry) => entry.target)).toEqual([
      { userId: "wed_active", channelId: "wed_active", platform: "web_e2ee" },
      fallback,
    ]);
    expect([...grouped.values()].map((entry) => entry.projections.map((p) => p.id))).toEqual([["stored"], ["legacy"]]);
  });

  it("does not start projection jobs when no primary user is configured", () => {
    const config = {
      ...makeConfig(),
      telegram: { token: "tok", allowed_users: [] },
      data_dir: tempDir,
    } as Config;
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const scheduler = createScheduler(config, vi.fn());
    scheduler.start();

    const logs = consoleSpy.mock.calls.map((c) => c[0]);
    expect(logs.some((l: string) => l.includes("Daily review scheduled"))).toBe(false);

    scheduler.stop();
    consoleSpy.mockRestore();
  });
});
