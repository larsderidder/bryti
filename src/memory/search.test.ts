/**
 * Tests for hybrid search.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHybridSearch, type SearchResult } from "./search.js";
import type { MemoryStore, ScoredResult } from "./store.js";

describe("HybridSearch", () => {
  // Mock store for testing
  const createMockStore = (keywordResults: ScoredResult[], vectorResults: ScoredResult[]): MemoryStore => ({
    addFact: vi.fn(),
    removeFact: vi.fn(),
    searchKeyword: vi.fn().mockResolvedValue(keywordResults),
    searchVector: vi.fn().mockResolvedValue(vectorResults),
    getAllFacts: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  });

  const createMockEmbed = (embedding: number[] = []) => vi.fn().mockResolvedValue(embedding);

  describe("merges keyword and vector results", () => {
    it("puts overlapping results first", async () => {
      const keywordResults: ScoredResult[] = [
        { id: "A", content: "Fact A", source: "test", timestamp: 1, score: -1 },
        { id: "B", content: "Fact B", source: "test", timestamp: 1, score: -2 },
      ];
      const vectorResults: ScoredResult[] = [
        { id: "B", content: "Fact B", source: "test", timestamp: 1, score: 0.9 },
        { id: "C", content: "Fact C", source: "test", timestamp: 1, score: 0.8 },
      ];

      const store = createMockStore(keywordResults, vectorResults);
      const embed = createMockEmbed();
      const search = createHybridSearch(store, embed);

      const results = await search("test query");

      // B appears in both and should be first
      expect(results[0].id).toBe("B");
      expect(results[0].matchedBy).toContain("keyword");
      expect(results[0].matchedBy).toContain("vector");
    });

    it("includes results from only one source", async () => {
      const keywordResults: ScoredResult[] = [
        { id: "A", content: "Fact A", source: "test", timestamp: 1, score: -1 },
      ];
      const vectorResults: ScoredResult[] = [
        { id: "C", content: "Fact C", source: "test", timestamp: 1, score: 0.8 },
      ];

      const store = createMockStore(keywordResults, vectorResults);
      const embed = createMockEmbed();
      const search = createHybridSearch(store, embed);

      const results = await search("test query");

      expect(results.length).toBe(2);
      expect(results.find((r) => r.id === "A")).toBeDefined();
      expect(results.find((r) => r.id === "C")).toBeDefined();
    });
  });

  describe("deduplicates across sources", () => {
    it("includes duplicate facts exactly once", async () => {
      const keywordResults: ScoredResult[] = [
        { id: "A", content: "Fact A", source: "test", timestamp: 1, score: -1 },
        { id: "B", content: "Fact B", source: "test", timestamp: 1, score: -2 },
      ];
      const vectorResults: ScoredResult[] = [
        { id: "B", content: "Fact B", source: "test", timestamp: 1, score: 0.9 },
      ];

      const store = createMockStore(keywordResults, vectorResults);
      const embed = createMockEmbed();
      const search = createHybridSearch(store, embed);

      const results = await search("test query");

      const bResults = results.filter((r) => r.id === "B");
      expect(bResults).toHaveLength(1);
    });
  });

  describe("respects limit parameter", () => {
    it("returns exactly the requested number of results", async () => {
      const keywordResults: ScoredResult[] = [
        { id: "A", content: "Fact A", source: "test", timestamp: 1, score: -1 },
        { id: "B", content: "Fact B", source: "test", timestamp: 1, score: -2 },
        { id: "C", content: "Fact C", source: "test", timestamp: 1, score: -3 },
        { id: "D", content: "Fact D", source: "test", timestamp: 1, score: -4 },
        { id: "E", content: "Fact E", source: "test", timestamp: 1, score: -5 },
      ];
      const vectorResults: ScoredResult[] = [];

      const store = createMockStore(keywordResults, vectorResults);
      const embed = createMockEmbed();
      const search = createHybridSearch(store, embed, { limit: 3 });

      const results = await search("test query");

      expect(results).toHaveLength(3);
    });
  });

  describe("returns empty for empty query", () => {
    it("returns empty array for empty string", async () => {
      const store = createMockStore([], []);
      const embed = createMockEmbed();
      const search = createHybridSearch(store, embed);

      const results = await search("");

      expect(results).toEqual([]);
    });

    it("returns empty array for whitespace only", async () => {
      const store = createMockStore([], []);
      const embed = createMockEmbed();
      const search = createHybridSearch(store, embed);

      const results = await search("   ");

      expect(results).toEqual([]);
    });
  });

  describe("handles partial matches", () => {
    it("works with only keyword matches", async () => {
      const keywordResults: ScoredResult[] = [
        { id: "A", content: "Fact A", source: "test", timestamp: 1, score: -1 },
      ];
      const vectorResults: ScoredResult[] = [];

      const store = createMockStore(keywordResults, vectorResults);
      const embed = createMockEmbed();
      const search = createHybridSearch(store, embed);

      const results = await search("test query");

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("A");
      expect(results[0].matchedBy).toContain("keyword");
      expect(results[0].matchedBy).not.toContain("vector");
    });

    it("works with only vector matches", async () => {
      const keywordResults: ScoredResult[] = [];
      const vectorResults: ScoredResult[] = [
        { id: "B", content: "Fact B", source: "test", timestamp: 1, score: 0.9 },
      ];

      const store = createMockStore(keywordResults, vectorResults);
      const embed = createMockEmbed();
      const search = createHybridSearch(store, embed);

      const results = await search("test query");

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("B");
      expect(results[0].matchedBy).toContain("vector");
      expect(results[0].matchedBy).not.toContain("keyword");
    });
  });

  describe("search with no indexed facts", () => {
    it("returns empty results when store is empty", async () => {
      const store = createMockStore([], []);
      const embed = createMockEmbed();
      const search = createHybridSearch(store, embed);

      const results = await search("test query");

      expect(results).toEqual([]);
    });
  });

  describe("score calculation", () => {
    it("calculates combined score correctly", async () => {
      // When a result appears in both, scores should be combined
      const keywordResults: ScoredResult[] = [
        { id: "A", content: "Fact A", source: "test", timestamp: 1, score: -1 },
      ];
      const vectorResults: ScoredResult[] = [
        { id: "A", content: "Fact A", source: "test", timestamp: 1, score: 0.9 },
      ];

      const store = createMockStore(keywordResults, vectorResults);
      const embed = createMockEmbed();
      const search = createHybridSearch(store, embed, {
        vectorWeight: 0.7,
        keywordWeight: 0.3,
        k: 60,
      });

      const results = await search("test query");

      // Score should be combination of both
      expect(results[0].combinedScore).toBeGreaterThan(0);
    });
  });
});
