/**
 * Tests for memory tools.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemorySearchTools } from "./memory-tools.js";
import type { HybridMemorySearch, SearchResult } from "./search.js";
import type { MemoryStore } from "./store.js";

describe("MemoryTools", () => {
  const createMockSearch = (results: SearchResult[]): HybridMemorySearch => ({
    search: vi.fn().mockResolvedValue(results),
  });

  const createMockStore = (): MemoryStore => ({
    addFact: vi.fn().mockReturnValue("fact-id"),
    removeFact: vi.fn(),
    searchKeyword: vi.fn().mockReturnValue([]),
    searchVector: vi.fn().mockReturnValue([]),
    getAllFacts: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  });

  const createMockEmbed = () => vi.fn().mockResolvedValue(new Array(768).fill(0.1));

  describe("search_memory tool", () => {
    it("returns results for known facts", async () => {
      const mockSearch = createMockSearch([
        {
          id: "1",
          content: "Lars lives in Amsterdam",
          source: "memory.md",
          timestamp: Date.now(),
          score: 0.9,
          combinedScore: 0.9,
          matchedBy: ["keyword", "vector"],
        },
      ]);

      const tools = createMemorySearchTools(
        mockSearch,
        createMockStore(),
        createMockEmbed(),
      );

      const searchTool = tools.find((t) => t.name === "search_memory")!;
      const result = await searchTool.execute("tool-call-id", { query: "where does Lars live" });

      expect(mockSearch.search).toHaveBeenCalledWith("where does Lars live");
      expect(result.details).toHaveProperty("results");
    });

    it("returns empty for no matches", async () => {
      const mockSearch = createMockSearch([]);

      const tools = createMemorySearchTools(
        mockSearch,
        createMockStore(),
        createMockEmbed(),
      );

      const searchTool = tools.find((t) => t.name === "search_memory")!;
      const result = await searchTool.execute("tool-call-id", { query: "quantum physics" });

      expect(result.details).toHaveProperty("results");
      expect((result.details as any).results).toHaveLength(0);
    });

    it("includes snippet, score, and source in results", async () => {
      const mockSearch = createMockSearch([
        {
          id: "1",
          content: "This is a very long piece of content about something important",
          source: "memory.md",
          timestamp: Date.now(),
          score: 0.9,
          combinedScore: 0.9,
          matchedBy: ["keyword"],
        },
      ]);

      const tools = createMemorySearchTools(
        mockSearch,
        createMockStore(),
        createMockEmbed(),
      );

      const searchTool = tools.find((t) => t.name === "search_memory")!;
      const result = await searchTool.execute("tool-call-id", { query: "test query" });

      const results = (result.details as any).results;
      expect(results[0]).toHaveProperty("snippet");
      expect(results[0]).toHaveProperty("score");
      expect(results[0]).toHaveProperty("source");
    });
  });

  describe("record_fact tool", () => {
    it("stores a fact that is searchable", async () => {
      const mockStore = createMockStore();
      const mockEmbed = createMockEmbed();

      const tools = createMemorySearchTools(
        createMockSearch([]),
        mockStore,
        mockEmbed,
      );

      const recordTool = tools.find((t) => t.name === "record_fact")!;
      await recordTool.execute("tool-call-id", { fact: "Meeting with Alice on Friday" });

      expect(mockStore.addFact).toHaveBeenCalledWith(
        "Meeting with Alice on Friday",
        "recorded",
        expect.any(Array),
      );
    });

    it("returns success message", async () => {
      const tools = createMemorySearchTools(
        createMockSearch([]),
        createMockStore(),
        createMockEmbed(),
      );

      const recordTool = tools.find((t) => t.name === "record_fact")!;
      const result = await recordTool.execute("tool-call-id", { fact: "Important thing" });

      expect(result.details).toHaveProperty("success", true);
    });
  });

});
