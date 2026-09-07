import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSlashCommand } from "./commands.js";
import { createCoreMemory } from "./memory/core-memory.js";
import { createHistoryManager } from "./history.js";
import { createTrustStore } from "./trust/index.js";
import { PERSONAL_ASSISTANT_DEFAULTS, type Config } from "./config.js";
import { createWorkStore } from "./work/store.js";

let tempDir = "";

function dataDir(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-commands-"));
  return tempDir;
}

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function config(dir: string): Config {
  return {
    agent: { name: "test", system_prompt: "", model: "test/model", fallback_models: [], thinking_level: "off", timezone: "UTC" },
    telegram: { token: "", mode: "dm", allowed_users: [123], allowed_groups: [] },
    whatsapp: { enabled: false, allowed_users: [] },
    threema: { enabled: false, gateway_id: "", secret: "", private_key_path: "", allowed_senders: [], api_base_url: "", callback: { host: "", port: 0, path: "" } },
    web_e2ee: { enabled: false, listen_host: "", listen_port: 0, public_origin: "", allowed_origins: [], path_prefix: "/", pairing: { invite_ttl_minutes: 10 } },
    models: { providers: [] },
    memory: { embeddings: { provider: "local", timeout_ms: 1000 } },
    tools: {
      web_search: { enabled: false, searxng_url: "" },
      fetch_url: { timeout_ms: 1000, backend: "readability", require_https: true },
      workers: { max_concurrent: 1, thinking_level: "medium", types: {} },
    },
    integrations: {},
    cron: [],
    voice: { enabled: false, transcribe_command: [], synthesize_command: [], reply_with_voice: true, keep_temp_files: false, command_timeout_ms: 1000, synthesized_audio_extension: ".ogg", max_tts_chars: 2500 },
    trust: { approved_tools: [] },
    agent_def: { ...PERSONAL_ASSISTANT_DEFAULTS },
    data_dir: dir,
  };
}

describe("handleSlashCommand", () => {
  it("accepts Telegram command mentions in groups", async () => {
    const dir = dataDir();
    const sendMessage = vi.fn(async () => "msg-id");

    const handled = await handleSlashCommand(
      { channelId: "-1001", userId: "123", platform: "telegram", text: "/new@bryti_bot Taxes", raw: {} },
      {
        config: config(dir),
        coreMemory: createCoreMemory(dir),
        historyManager: createHistoryManager(dir),
        disposeSession: vi.fn(),
        sendMessage,
        triggerRestart: vi.fn(),
      },
    );

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith("-1001", "Created and switched to thread: Taxes");
  });


  it("lists and revokes trust grants", async () => {
    const dir = dataDir();
    const trustStore = createTrustStore(dir, ["config_tool"]);
    const grant = trustStore.approveInvocation("shell_exec", { command: "npm test" }, "always", {
      userId: "123",
      platform: "telegram",
      channelId: "-1001",
      channelThreadId: "77",
      source: "user",
    }, "2099-01-01T00:00:00.000Z");
    const sendMessage = vi.fn(async () => "msg-id");

    const listed = await handleSlashCommand(
      { channelId: "-1001", userId: "123", platform: "telegram", text: "/trust", raw: {}, channelThreadId: "77" },
      {
        config: config(dir),
        coreMemory: createCoreMemory(dir),
        historyManager: createHistoryManager(dir),
        trustStore,
        disposeSession: vi.fn(),
        sendMessage,
        triggerRestart: vi.fn(),
      },
    );

    expect(listed).toBe(true);
    expect(sendMessage).toHaveBeenLastCalledWith("-1001", expect.stringContaining(grant.id));
    expect(sendMessage).toHaveBeenLastCalledWith("-1001", expect.stringContaining("topic 77"));
    expect(sendMessage).toHaveBeenLastCalledWith("-1001", expect.stringContaining("config_tool"));

    const revoked = await handleSlashCommand(
      { channelId: "-1001", userId: "123", platform: "telegram", text: `/trust revoke ${grant.id}`, raw: {}, channelThreadId: "77" },
      {
        config: config(dir),
        coreMemory: createCoreMemory(dir),
        historyManager: createHistoryManager(dir),
        trustStore,
        disposeSession: vi.fn(),
        sendMessage,
        triggerRestart: vi.fn(),
      },
    );

    expect(revoked).toBe(true);
    expect(trustStore.isInvocationApproved("shell_exec", { command: "npm test" }, {
      userId: "123",
      platform: "telegram",
      channelId: "-1001",
      channelThreadId: "77",
      source: "user",
    })).toBe(false);
  });

  it("does not disclose or revoke another user's approval grants", async () => {
    const dir = dataDir();
    const trustStore = createTrustStore(dir, []);
    const grant = trustStore.approveInvocation("shell_exec", { command: "private-operation" }, "always", { userId: "456" });
    const sendMessage = vi.fn(async () => "sent");
    const context = { config: config(dir), coreMemory: createCoreMemory(dir), historyManager: createHistoryManager(dir), trustStore,
      sendMessage, disposeSession: vi.fn(), triggerRestart: vi.fn() };
    const message = { channelId: "123", userId: "123", platform: "telegram" as const, text: "/trust", raw: null };
    await handleSlashCommand(message, context);
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("private-operation");
    await handleSlashCommand({ ...message, text: `/trust revoke ${grant.id}` }, context);
    expect(trustStore.listApproved().some((record) => record.id === grant.id)).toBe(true);
  });

  it("shows unresolved receipts only to their owner", async () => {
    const dir = dataDir();
    const workStore = createWorkStore(dir);
    const own = workStore.accept({ channelId: "123", userId: "123", platform: "telegram", text: "Own task", raw: null }).record;
    const other = workStore.accept({ channelId: "456", userId: "456", platform: "telegram", text: "Private other task", raw: null }).record;
    workStore.claim([own.id, other.id]);
    workStore.finish([own.id, other.id], "failed");
    const sendMessage = vi.fn(async () => "sent");
    const context = { config: config(dir), coreMemory: createCoreMemory(dir), historyManager: createHistoryManager(dir), workStore,
      sendMessage, disposeSession: vi.fn(), triggerRestart: vi.fn() };
    const message = { channelId: "123", userId: "123", platform: "telegram" as const, text: "/work", raw: null };
    try {
      await handleSlashCommand(message, context);
      expect(JSON.stringify(sendMessage.mock.calls)).toContain("Own task");
      expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("Private other task");
      await handleSlashCommand({ ...message, text: `/work ${other.id}` }, context);
      expect(JSON.stringify(sendMessage.mock.calls)).not.toContain("Private other task");
    } finally {
      workStore.close();
    }
  });
});
