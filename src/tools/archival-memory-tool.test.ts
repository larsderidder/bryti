import { describe, it, expect, vi } from "vitest";
import { createArchivalMemoryTools } from "./archival-memory-tool.js";
import type { MemoryStore, ScoredResult } from "../memory/store.js";

const createMockStore = (keywordResults: ScoredResult[] = [], vectorResults: ScoredResult[] = []): MemoryStore => ({
  addFact: vi.fn().mockReturnValue("fact-id"),
  removeFact: vi.fn(),
  searchKeyword: vi.fn().mockResolvedValue(keywordResults),
  searchVector: vi.fn().mockResolvedValue(vectorResults),
  close: vi.fn(),
});

describe("ArchivalMemoryTools", () => {
  it("inserts archival memory", async () => {
    const store = createMockStore();
    const embed = vi.fn().mockResolvedValue(new Array(768).fill(0.1));
    const tools = createArchivalMemoryTools(store, embed);

    const insertTool = tools.find((tool) => tool.name === "archival_memory_insert")!;
    const result = await insertTool.execute("call1", { content: "Meeting notes" });

    expect(result.details).toEqual({ success: true });
    expect(store.addFact).toHaveBeenCalled();
  });

  it("searches archival memory", async () => {
    const store = createMockStore([
      {
        id: "1",
        content: "Meeting with Alice on Friday",
        source: "archival",
        timestamp: Date.now(),
        score: 1,
      },
    ]);
    const embed = vi.fn().mockResolvedValue(new Array(768).fill(0.2));
    const tools = createArchivalMemoryTools(store, embed);

    const searchTool = tools.find((tool) => tool.name === "archival_memory_search")!;
    const result = await searchTool.execute("call1", { query: "Alice" });

    expect(result.details).toHaveProperty("results");
    expect((result.details as any).results[0]).toHaveProperty("content");
  });
});
