import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { createCoreMemory } from "../memory/core-memory.js";
import { createCoreMemoryTools } from "./core-memory-tool.js";

describe("CoreMemoryTools", () => {
  let tempDir: string;
  let tools: ReturnType<typeof createCoreMemoryTools>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/bryti-core-memory-tool-");
    tools = createCoreMemoryTools(createCoreMemory(tempDir));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends to core memory", async () => {
    const appendTool = tools.find((t) => t.name === "memory_core_append")!;
    const result = await appendTool.execute(
      "call1",
      { section: "Preferences", content: "Likes coffee" },
      undefined,
      undefined,
      undefined as any,
    );

    expect(result.details).toEqual({ success: true });
  });

  it("returns error on missing section replace", async () => {
    const replaceTool = tools.find((t) => t.name === "memory_core_replace")!;
    const result = await replaceTool.execute(
      "call1",
      { section: "Preferences", old_text: "coffee", new_text: "tea" },
      undefined,
      undefined,
      undefined as any,
    );

    expect(result.details).toEqual({ error: "Section 'Preferences' not found" });
  });
});
