import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSlashCommand } from "./commands.js";
import { createCoreMemory } from "./memory/core-memory.js";
import { createHistoryManager } from "./history.js";
import type { Config } from "./config.js";

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
    agent: { name: "test", system_prompt: "", model: "test/model", fallback_models: [], timezone: "UTC" },
    telegram: { token: "", mode: "dm", allowed_users: [123], allowed_groups: [] },
    whatsapp: { enabled: false, allowed_users: [] },
    threema: { enabled: false, gateway_id: "", secret: "", private_key_path: "", allowed_senders: [], api_base_url: "", callback: { host: "", port: 0, path: "" } },
    web_e2ee: { enabled: false, listen_host: "", listen_port: 0, public_origin: "", allowed_origins: [], path_prefix: "/", pairing: { invite_ttl_minutes: 10 } },
    models: { providers: [] },
    memory: { embeddings: { provider: "local", timeout_ms: 1000 }, reflection: true, daily_review: true, compaction: "conversational" },
    tools: {
      web_search: { enabled: false, searxng_url: "" },
      fetch_url: { timeout_ms: 1000, backend: "readability", require_https: true },
      workers: { max_concurrent: 1, default_timeout_seconds: 60, thinking_level: "medium", types: {} },
    },
    integrations: {},
    cron: [],
    voice: { enabled: false, transcribe_command: [], synthesize_command: [], reply_with_voice: true, keep_temp_files: false, command_timeout_ms: 1000, synthesized_audio_extension: ".ogg", max_tts_chars: 2500 },
    trust: { approved_tools: [] },
    agent_def: { tool_groups: [], prompt_sections: [], tone: "conversational", memory: { reflection: true, daily_review: true, compaction: "conversational" }, extension_files: [], skill_files: [] },
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
});
