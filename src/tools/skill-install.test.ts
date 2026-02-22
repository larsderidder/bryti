import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSkillInstallTool } from "./skill-install.js";

let tmpDir: string;
let tool: ReturnType<typeof createSkillInstallTool>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-install-test-"));
  fs.mkdirSync(path.join(tmpDir, "skills"), { recursive: true });
  tool = createSkillInstallTool(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("skill_install", () => {
  it("installs from a local directory", async () => {
    // Create a fake skill directory
    const srcDir = path.join(tmpDir, "src-skill");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "SKILL.md"), "---\nname: test\n---\n# Test skill");
    fs.writeFileSync(path.join(srcDir, "reference.md"), "Some reference data");

    const result = await tool.execute("call-1", { name: "test-skill", source: srcDir });
    const text = JSON.stringify(result);
    expect(text).toContain("installed");

    const installed = path.join(tmpDir, "skills", "test-skill");
    expect(fs.existsSync(path.join(installed, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(installed, "reference.md"))).toBe(true);
  });

  it("installs from a local SKILL.md file", async () => {
    const srcFile = path.join(tmpDir, "my-skill.md");
    fs.writeFileSync(srcFile, "---\nname: solo\n---\n# Solo skill");

    const result = await tool.execute("call-2", { name: "solo", source: srcFile });
    const text = JSON.stringify(result);
    expect(text).toContain("installed");

    expect(fs.existsSync(path.join(tmpDir, "skills", "solo", "SKILL.md"))).toBe(true);
  });

  it("rejects directory without SKILL.md", async () => {
    const srcDir = path.join(tmpDir, "no-skill");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "readme.md"), "not a skill");

    const result = await tool.execute("call-3", { name: "bad", source: srcDir });
    const text = JSON.stringify(result);
    expect(text).toContain("No SKILL.md");
  });

  it("rejects invalid skill names", async () => {
    const result = await tool.execute("call-4", { name: "My Skill!", source: "/tmp" });
    const text = JSON.stringify(result);
    expect(text).toContain("lowercase");
  });

  it("rejects non-existent local path", async () => {
    const result = await tool.execute("call-5", { name: "gone", source: "/tmp/does-not-exist-xyz" });
    const text = JSON.stringify(result);
    expect(text).toContain("not found");
  });

  it("rejects source that is neither path nor URL", async () => {
    const result = await tool.execute("call-6", { name: "bad", source: "relative/path" });
    const text = JSON.stringify(result);
    expect(text).toContain("absolute local path");
  });
});
