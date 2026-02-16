import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { createMemoryManager } from "../memory.js";
import { createMemoryTools } from "./memory-tool.js";

describe("MemoryTools", () => {
  let tempDir: string;
  let memoryManager: ReturnType<typeof createMemoryManager>;
  let tools: ReturnType<typeof createMemoryTools>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/pibot-test-");
    memoryManager = createMemoryManager(tempDir);
    tools = createMemoryTools(memoryManager);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("read_memory", () => {
    it("should return empty for new memory", async () => {
      const readMemoryTool = tools.find((t) => t.name === "read_memory")!;
      const result = await readMemoryTool.execute("call1", {}, undefined, undefined, undefined as any);

      expect(result.content[0]).toHaveProperty("text");
      const text = (result.content[0] as any).text;
      expect(text).toContain('"content": ""');
    });
  });

  describe("update_memory", () => {
    it("should update memory", async () => {
      const updateMemoryTool = tools.find((t) => t.name === "update_memory")!;
      await updateMemoryTool.execute(
        "call1",
        { content: "John's email is john@example.com" },
        undefined,
        undefined,
        undefined as any,
      );

      const readMemoryTool = tools.find((t) => t.name === "read_memory")!;
      const result = await readMemoryTool.execute("call1", {}, undefined, undefined, undefined as any);

      expect(result.content[0]).toHaveProperty("text");
      const text = (result.content[0] as any).text;
      expect(text).toContain("john@example.com");
    });
  });
});
