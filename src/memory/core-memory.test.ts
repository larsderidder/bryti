import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createCoreMemory, type CoreMemory } from "./core-memory.js";

describe("CoreMemory", () => {
  let tempDir: string;
  let coreMemory: CoreMemory;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/pibot-core-memory-");
    coreMemory = createCoreMemory(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty string for fresh file", () => {
    expect(coreMemory.read()).toBe("");
  });

  it("appends to empty file and creates section", () => {
    const result = coreMemory.append("Preferences", "Likes coffee");
    expect(result).toEqual({ ok: true });
    expect(coreMemory.read()).toBe("## Preferences\nLikes coffee");
  });

  it("appends to existing section without overwriting", () => {
    coreMemory.append("Preferences", "Likes coffee");
    coreMemory.append("Preferences", "Hates tea");

    const content = coreMemory.read();
    expect(content).toContain("## Preferences");
    expect(content).toContain("Likes coffee");
    expect(content).toContain("Hates tea");
  });

  it("creates new section when missing", () => {
    coreMemory.append("New Section", "content");
    expect(coreMemory.read()).toContain("## New Section");
  });

  it("replaces text within a section", () => {
    coreMemory.append("Preferences", "Likes coffee");

    const result = coreMemory.replace("Preferences", "coffee", "tea");
    expect(result).toEqual({ ok: true });
    expect(coreMemory.read()).toContain("Likes tea");
  });

  it("returns error when text not found", () => {
    coreMemory.append("Preferences", "Likes coffee");
    const before = coreMemory.read();

    const result = coreMemory.replace("Preferences", "nonexistent", "new");

    expect(result).toEqual({ ok: false, error: "Text not found in section 'Preferences'" });
    expect(coreMemory.read()).toBe(before);
  });

  it("returns error when section is missing", () => {
    const result = coreMemory.replace("Missing", "a", "b");
    expect(result).toEqual({ ok: false, error: "Section 'Missing' not found" });
  });

  it("returns error when append exceeds size limit", () => {
    const bigContent = "a".repeat(4097);
    const result = coreMemory.append("Preferences", bigContent);

    expect(result).toEqual({
      ok: false,
      error:
        "Core memory is full (4KB limit). Move less important information to archival memory using archival_memory_insert.",
    });
    expect(coreMemory.read()).toBe("");
  });

  it("persists content across instances", () => {
    coreMemory.append("Preferences", "Likes coffee");

    const newInstance = createCoreMemory(tempDir);
    expect(newInstance.read()).toBe("## Preferences\nLikes coffee");
  });

  it("operations on one section do not affect others", () => {
    coreMemory.append("Preferences", "Likes coffee");
    coreMemory.append("Projects", "Pibot");

    coreMemory.replace("Preferences", "coffee", "tea");

    const content = coreMemory.read();
    expect(content).toContain("## Preferences");
    expect(content).toContain("Likes tea");
    expect(content).toContain("## Projects");
    expect(content).toContain("Pibot");
  });

  it("stores file in the data directory", () => {
    expect(coreMemory.filePath).toBe(path.join(tempDir, "core-memory.md"));
  });
});
