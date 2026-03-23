/**
 * Tests for the bryti init --template scaffolding.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldAgent } from "./init-template.js";
import { PERSONAL_ASSISTANT_TEMPLATE } from "./templates/index.js";
import { DEVOPS_MONITOR_TEMPLATE } from "./templates/index.js";
import { TEMPLATES } from "./templates/index.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bryti-init-test-"));
}

describe("scaffoldAgent", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("creates expected directory structure", () => {
    scaffoldAgent(PERSONAL_ASSISTANT_TEMPLATE, tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "agent.yml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "core-memory.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "files", "extensions"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "files", "extensions", "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "users"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "history"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "logs"))).toBe(true);
  });

  it("agent.yml contains template content", () => {
    scaffoldAgent(PERSONAL_ASSISTANT_TEMPLATE, tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "agent.yml"), "utf-8");
    expect(content).toContain("conversational");
    expect(content).toContain("memory_core");
    expect(content).toContain("daily_review: true");
  });

  it("devops-monitor template writes operational config", () => {
    scaffoldAgent(DEVOPS_MONITOR_TEMPLATE, tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, "agent.yml"), "utf-8");
    expect(content).toContain("operational");
    expect(content).toContain("daily_review: false");
    expect(content).toContain("guardrails:");
    // Should not register self-modification tools
    expect(content).not.toContain("extensions_management\n");
  });

  it("skips existing agent.yml without --force", () => {
    const existing = "# my custom config\n";
    fs.writeFileSync(path.join(tmpDir, "agent.yml"), existing, "utf-8");

    const { skipped } = scaffoldAgent(PERSONAL_ASSISTANT_TEMPLATE, tmpDir);

    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]).toContain("agent.yml");
    // Original content preserved
    expect(fs.readFileSync(path.join(tmpDir, "agent.yml"), "utf-8")).toBe(existing);
  });

  it("overwrites existing agent.yml with --force", () => {
    const existing = "# my custom config\n";
    fs.writeFileSync(path.join(tmpDir, "agent.yml"), existing, "utf-8");

    const { skipped } = scaffoldAgent(PERSONAL_ASSISTANT_TEMPLATE, tmpDir, true);

    expect(skipped).toHaveLength(0);
    const content = fs.readFileSync(path.join(tmpDir, "agent.yml"), "utf-8");
    expect(content).not.toBe(existing);
    expect(content).toContain("conversational");
  });

  it("creates target directory if it does not exist", () => {
    const nested = path.join(tmpDir, "new", "agent-dir");
    expect(fs.existsSync(nested)).toBe(false);
    scaffoldAgent(PERSONAL_ASSISTANT_TEMPLATE, nested);
    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.existsSync(path.join(nested, "agent.yml"))).toBe(true);
  });
});

describe("TEMPLATES registry", () => {
  it("contains personal-assistant and devops-monitor", () => {
    expect(TEMPLATES["personal-assistant"]).toBeDefined();
    expect(TEMPLATES["devops-monitor"]).toBeDefined();
  });

  it("all templates have required fields", () => {
    for (const [id, t] of Object.entries(TEMPLATES)) {
      expect(t.id).toBe(id);
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.agentYml).toBeTruthy();
    }
  });
});
