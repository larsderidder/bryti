import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createMemoryManager, type MemoryManager } from "../src/memory.js";

describe("MemoryManager", () => {
  let tempDir: string;
  let memoryManager: MemoryManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/pibot-test-");
    memoryManager = createMemoryManager(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return empty string for new memory", async () => {
    const content = await memoryManager.read();
    expect(content).toBe("");
  });

  it("should write and read memory", async () => {
    const testContent = "This is a test memory";
    await memoryManager.update(testContent);
    const content = await memoryManager.read();
    expect(content).toBe(testContent);
  });

  it("should overwrite existing memory", async () => {
    await memoryManager.update("First");
    await memoryManager.update("Second");
    const content = await memoryManager.read();
    expect(content).toBe("Second");
  });

  it("should have correct file path", () => {
    expect(memoryManager.filePath).toBe(path.join(tempDir, "memory.md"));
  });
});
