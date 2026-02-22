/**
 * Tests for the config snapshot / rollback mechanism.
 *
 * The logic under test lives in index.ts as module-level helpers.
 * We test the observable behaviour via filesystem state rather than
 * importing the private functions directly.
 *
 * Strategy: replicate the three helpers (snapshotConfig, loadConfigWithRollback,
 * configSnapshotPath) inline so we can unit-test them without spinning up the
 * full app. The real implementations in index.ts are covered by integration
 * tests (run.sh e2e), but the logic branches are cheap to cover here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers copied from index.ts (DRY-violation justified: avoids importing the
// entire app entry point which tries to start Telegram, WhatsApp, etc.)
// ---------------------------------------------------------------------------

function configSnapshotPath(dataDir: string): string {
  return path.join(dataDir, "pending", "config.yml.pre-restart");
}

function snapshotConfig(dataDir: string): void {
  const src = path.join(dataDir, "config.yml");
  const dst = configSnapshotPath(dataDir);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function loadConfigWithRollback(dataDir: string): {
  config: ReturnType<typeof loadConfig>;
  rolledBack: boolean;
  rollbackReason?: string;
} {
  try {
    const config = loadConfig();
    const snap = configSnapshotPath(dataDir);
    if (fs.existsSync(snap)) {
      fs.rmSync(snap, { force: true });
    }
    return { config, rolledBack: false };
  } catch (err) {
    const snap = configSnapshotPath(dataDir);
    if (!fs.existsSync(snap)) {
      throw err;
    }

    const reason = (err as Error).message;
    const cfgPath = path.join(dataDir, "config.yml");
    fs.copyFileSync(snap, cfgPath);
    fs.rmSync(snap, { force: true });

    const config = loadConfig();
    return { config, rolledBack: true, rollbackReason: reason };
  }
}

// ---------------------------------------------------------------------------
// Minimal valid config YAML
// ---------------------------------------------------------------------------

const VALID_CONFIG = `
agent:
  name: TestBot
  system_prompt: "You are a test bot"
  model: "test/model"
telegram:
  token: "test-token"
  allowed_users: [123]
models:
  providers:
    - name: test
      base_url: https://test.example.com
      api_key: test-key
      models:
        - id: test-model
tools:
  web_search:
    enabled: true
    searxng_url: "https://search.example.com"
cron: []
`;

const INVALID_CONFIG = `this: is: not: valid: yaml: [[[`;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-rollback-"));
  fs.mkdirSync(path.join(tmpDir, "pending"), { recursive: true });
  process.env.BRYTI_DATA_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.BRYTI_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// snapshotConfig
// ---------------------------------------------------------------------------

describe("snapshotConfig", () => {
  it("copies config.yml to pending/config.yml.pre-restart", () => {
    fs.writeFileSync(path.join(tmpDir, "config.yml"), VALID_CONFIG);

    snapshotConfig(tmpDir);

    const snap = configSnapshotPath(tmpDir);
    expect(fs.existsSync(snap)).toBe(true);
    expect(fs.readFileSync(snap, "utf8")).toBe(VALID_CONFIG);
  });

  it("does nothing when config.yml does not exist", () => {
    snapshotConfig(tmpDir);

    expect(fs.existsSync(configSnapshotPath(tmpDir))).toBe(false);
  });

  it("creates the pending directory if missing", () => {
    fs.rmdirSync(path.join(tmpDir, "pending"));
    fs.writeFileSync(path.join(tmpDir, "config.yml"), VALID_CONFIG);

    snapshotConfig(tmpDir);

    expect(fs.existsSync(configSnapshotPath(tmpDir))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadConfigWithRollback — happy path
// ---------------------------------------------------------------------------

describe("loadConfigWithRollback — valid config", () => {
  it("loads config normally and returns rolledBack=false", () => {
    fs.writeFileSync(path.join(tmpDir, "config.yml"), VALID_CONFIG);

    const result = loadConfigWithRollback(tmpDir);

    expect(result.rolledBack).toBe(false);
    expect(result.rollbackReason).toBeUndefined();
    expect(result.config.agent.name).toBe("TestBot");
  });

  it("deletes snapshot on successful load", () => {
    fs.writeFileSync(path.join(tmpDir, "config.yml"), VALID_CONFIG);
    // Plant a leftover snapshot (from a previous restart that succeeded)
    fs.writeFileSync(configSnapshotPath(tmpDir), VALID_CONFIG);

    loadConfigWithRollback(tmpDir);

    expect(fs.existsSync(configSnapshotPath(tmpDir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadConfigWithRollback — rollback path
// ---------------------------------------------------------------------------

describe("loadConfigWithRollback — invalid config with snapshot", () => {
  it("restores snapshot and returns rolledBack=true", () => {
    // Snapshot contains the old good config
    fs.writeFileSync(configSnapshotPath(tmpDir), VALID_CONFIG);
    // Current config.yml is broken
    fs.writeFileSync(path.join(tmpDir, "config.yml"), INVALID_CONFIG);

    const result = loadConfigWithRollback(tmpDir);

    expect(result.rolledBack).toBe(true);
    expect(result.rollbackReason).toBeTruthy();
    expect(result.config.agent.name).toBe("TestBot");
  });

  it("config.yml is replaced with snapshot content after rollback", () => {
    fs.writeFileSync(configSnapshotPath(tmpDir), VALID_CONFIG);
    fs.writeFileSync(path.join(tmpDir, "config.yml"), INVALID_CONFIG);

    loadConfigWithRollback(tmpDir);

    const restored = fs.readFileSync(path.join(tmpDir, "config.yml"), "utf8");
    expect(restored).toBe(VALID_CONFIG);
  });

  it("snapshot is deleted after rollback", () => {
    fs.writeFileSync(configSnapshotPath(tmpDir), VALID_CONFIG);
    fs.writeFileSync(path.join(tmpDir, "config.yml"), INVALID_CONFIG);

    loadConfigWithRollback(tmpDir);

    expect(fs.existsSync(configSnapshotPath(tmpDir))).toBe(false);
  });

  it("rollbackReason contains the parse/validation error message", () => {
    fs.writeFileSync(configSnapshotPath(tmpDir), VALID_CONFIG);
    fs.writeFileSync(path.join(tmpDir, "config.yml"), INVALID_CONFIG);

    const result = loadConfigWithRollback(tmpDir);

    expect(result.rollbackReason).toMatch(/yaml|parse|invalid/i);
  });
});

// ---------------------------------------------------------------------------
// loadConfigWithRollback — no snapshot, broken config → propagate error
// ---------------------------------------------------------------------------

describe("loadConfigWithRollback — invalid config without snapshot", () => {
  it("throws when no snapshot is available", () => {
    fs.writeFileSync(path.join(tmpDir, "config.yml"), INVALID_CONFIG);

    expect(() => loadConfigWithRollback(tmpDir)).toThrow();
  });
});
