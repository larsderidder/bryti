import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createConversationSearchTool } from "./conversation-search-tool.js";

describe("ConversationSearchTool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/pibot-conversation-tool-");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const writeJsonl = (fileName: string, lines: string[]) => {
    fs.writeFileSync(path.join(tempDir, fileName), lines.join("\n"), "utf-8");
  };

  it("returns search results", async () => {
    writeJsonl("2026-02-16.jsonl", [
      JSON.stringify({ role: "user", content: "Dentist reminder", timestamp: "2026-02-16T12:00:00Z" }),
    ]);

    const tool = createConversationSearchTool(tempDir);
    const result = await tool.execute("call1", { query: "dentist" });

    expect(result.details).toHaveProperty("results");
    expect((result.details as any).results).toHaveLength(1);
  });
});
