/**
 * Tests for tool group filtering in createTools().
 *
 * Verifies that only the tool groups declared in config.agent_def.tool_groups
 * are registered. Uses a mock config and minimal stubs to avoid needing
 * a real file system or LLM.
 */

import { describe, it, expect } from "vitest";
import { createTools } from "./index.js";
import { PERSONAL_ASSISTANT_DEFAULTS } from "../config.js";
import type { Config, ToolGroup } from "../config.js";
import type { CoreMemory } from "../memory/core-memory.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-tools-test-"));
  // Ensure subdirectories that tools expect to exist
  for (const sub of ["logs", "history", "files", "files/extensions", ".models", "users/test-user"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

function makeConfig(dataDir: string, groups: ToolGroup[]): Config {
  return {
    agent: {
      name: "TestBot",
      system_prompt: "You are TestBot.",
      model: "anthropic/claude-test",
      fallback_models: [],
      timezone: "Europe/Amsterdam",
    },
    telegram: { token: "tok", allowed_users: [1] },
    whatsapp: { enabled: false, allowed_users: [] },
    models: { providers: [] },
    tools: {
      web_search: { enabled: false, searxng_url: "" },
      fetch_url: { timeout_ms: 5000 },
      workers: { max_concurrent: 1, types: {} },
    },
    integrations: {},
    cron: [],
    trust: { approved_tools: [] },
    agent_def: { ...PERSONAL_ASSISTANT_DEFAULTS, tool_groups: groups },
    data_dir: dataDir,
  } as unknown as Config;
}

const stubMemory: CoreMemory = {
  get: () => "",
  append: async () => {},
  replace: async () => {},
};

function toolNames(config: Config, dataDir: string): string[] {
  const tools = createTools(config, stubMemory, "test-user");
  return tools.map((t) => t.name).sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool group filtering", () => {
  it("personal-assistant preset registers all expected tool groups", () => {
    const dataDir = makeTmpDir();
    const config = makeConfig(dataDir, [...PERSONAL_ASSISTANT_DEFAULTS.tool_groups]);
    const names = toolNames(config, dataDir);

    // Spot-check one tool from each group
    expect(names).toContain("memory_core_append");
    expect(names).toContain("memory_archival_search");
    expect(names).toContain("memory_conversation_search");
    expect(names).toContain("file_write");
    expect(names).toContain("system_log");
    expect(names).toContain("skill_install");
    expect(names).toContain("worker_dispatch");
    expect(names).toContain("pi_session_read");
  });

  it("devops-monitor groups registers only declared tools", () => {
    const dataDir = makeTmpDir();
    const config = makeConfig(dataDir, ["memory_core", "memory_archival", "projections", "system_log"]);
    const names = toolNames(config, dataDir);

    // Present
    expect(names).toContain("memory_core_append");
    expect(names).toContain("memory_core_replace");
    expect(names).toContain("memory_archival_insert");
    expect(names).toContain("memory_archival_search");
    expect(names).toContain("system_log");

    // Absent
    expect(names).not.toContain("file_write");
    expect(names).not.toContain("worker_dispatch");
    expect(names).not.toContain("skill_install");
    expect(names).not.toContain("system_restart");
    expect(names).not.toContain("pi_session_inject");
    expect(names).not.toContain("memory_conversation_search");
  });

  it("empty group list registers no domain tools (only trust capabilities)", () => {
    const dataDir = makeTmpDir();
    const config = makeConfig(dataDir, []);
    const names = toolNames(config, dataDir);
    expect(names).toHaveLength(0);
  });

  it("single group — files only", () => {
    const dataDir = makeTmpDir();
    const config = makeConfig(dataDir, ["files"]);
    const names = toolNames(config, dataDir);

    expect(names).toContain("file_write");
    expect(names).not.toContain("memory_core_append");
    expect(names).not.toContain("worker_dispatch");
  });

  it("workers group includes dispatch, check, interrupt, steer", () => {
    const dataDir = makeTmpDir();
    const config = makeConfig(dataDir, ["workers", "memory_archival", "projections"]);
    const names = toolNames(config, dataDir);

    expect(names).toContain("worker_dispatch");
    expect(names).toContain("worker_check");
    expect(names).toContain("worker_interrupt");
    expect(names).toContain("worker_steer");
  });

  it("system_restart is registered when extensions_management is enabled and onRestart provided", () => {
    const dataDir = makeTmpDir();
    const config = makeConfig(dataDir, ["extensions_management"]);
    const tools = createTools(config, stubMemory, "test-user", undefined, async () => {});
    const names = tools.map((t) => t.name);

    expect(names).toContain("skill_install");
    expect(names).toContain("system_restart");
  });

  it("system_restart is absent when extensions_management is enabled but no onRestart", () => {
    const dataDir = makeTmpDir();
    const config = makeConfig(dataDir, ["extensions_management"]);
    const tools = createTools(config, stubMemory, "test-user");
    const names = tools.map((t) => t.name);

    expect(names).toContain("skill_install");
    expect(names).not.toContain("system_restart");
  });
});
