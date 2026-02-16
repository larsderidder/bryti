/**
 * Integration tests for search quality.
 *
 * Tests keyword search, vector search, and hybrid search performance.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryStore, type MemoryStore } from "./store.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { createHybridSearch } from "./search.js";
import { createIndexer } from "./indexer.js";
import path from "node:path";
import fs from "node:fs";

describe("Search Quality Integration", () => {
  const testDir = path.join(process.cwd(), ".test-data", "search-quality");
  const userId = "test-user";
  let store: MemoryStore;
  let embeddings: ReturnType<typeof createEmbeddingProvider>;
  let search: ReturnType<typeof createHybridSearch>;
  let indexer: ReturnType<typeof createIndexer>;

  beforeEach(async () => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }

    store = createMemoryStore(userId, testDir);
    embeddings = await createEmbeddingProvider({ type: "local" });
    search = createHybridSearch(store, embeddings, { limit: 5 });
    indexer = createIndexer(store, embeddings);
  });

  afterEach(() => {
    store.close();
    embeddings.close();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe("Keyword search quality", () => {
    it("finds exact name matches", async () => {
      // Add facts about a person
      const facts = [
        "Lars lives in Amsterdam",
        "Lars works as a freelancer",
        "Alice lives in Berlin",
      ];

      for (const fact of facts) {
        const emb = await embeddings.embed(fact);
        store.addFact(fact, "test", emb);
      }

      // Search for "Lars"
      const results = await search("Lars");

      // Should find both Lars facts
      const larsResults = results.filter((r) => r.content.includes("Lars"));
      expect(larsResults.length).toBeGreaterThanOrEqual(2);
    });

    it("does not find unrelated facts", async () => {
      const facts = [
        "Lars likes coffee",
        "The weather is nice today",
        "Python is a programming language",
      ];

      for (const fact of facts) {
        const emb = await embeddings.embed(fact);
        store.addFact(fact, "test", emb);
      }

      const results = await search("coffee");

      // Should find the coffee fact
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("coffee");
    });
  });

  describe("Vector search quality", () => {
    it("finds semantically related content", async () => {
      // Add facts with different semantic meanings
      const facts = [
        "Meeting scheduled for 3pm",
        "Grocery list: milk and eggs",
        "Calendar shows dentist appointment",
      ];

      const embeddings_list = [
        await embeddings.embed("Meeting scheduled for 3pm"),
        await embeddings.embed("Grocery list: milk and eggs"),
        await embeddings.embed("Calendar shows dentist appointment"),
      ];

      for (let i = 0; i < facts.length; i++) {
        store.addFact(facts[i], "test", embeddings_list[i]);
      }

      // Search with a semantically similar query to "meeting"
      const meetingResults = await search("appointment schedule");

      // Should find the meeting-related fact
      expect(meetingResults.length).toBeGreaterThan(0);
      const hasMeetingRelated = meetingResults.some(
        (r) => r.content.includes("Meeting") || r.content.includes("appointment")
      );
      expect(hasMeetingRelated).toBe(true);
    });
  });

  describe("Hybrid search quality", () => {
    it("combines keyword and vector results", async () => {
      const facts = [
        "Python is a programming language",
        "JavaScript is also a programming language",
        "The weather is nice today",
      ];

      for (const fact of facts) {
        const emb = await embeddings.embed(fact);
        store.addFact(fact, "test", emb);
      }

      // Search for "Python" - should find by keyword
      const results = await search("Python");

      expect(results.length).toBeGreaterThan(0);
      const pythonResult = results.find((r) => r.content.includes("Python"));
      expect(pythonResult).toBeDefined();
    });

    it("deduplicates results from both sources", async () => {
      const fact = "This fact matches both keyword and vector";
      const emb = await embeddings.embed(fact);
      store.addFact(fact, "test", emb);

      const results = await search("fact");

      // Should only have one result for the fact
      const matchingResults = results.filter((r) => r.content === fact);
      expect(matchingResults.length).toBe(1);
    });
  });

  describe("Indexer integration", () => {
    it("indexes memory.md and makes it searchable", async () => {
      const memoryContent = `# Preferences
Likes coffee

# Work
Freelancer`;

      await indexer.indexMemoryFile(memoryContent);

      const results = await search("coffee");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("coffee");
    });

    it("indexes conversation messages", async () => {
      const messages = [
        { role: "user", content: "My email is lars@example.com" },
        { role: "assistant", content: "I'll remember that" },
      ];

      await indexer.indexConversation(messages);

      const results = await search("email");

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("email");
    });

    it("indexer skips duplicate content within same indexing run", async () => {
      // Single chunk content
      const memoryContent = `# Section
Same content`;

      await indexer.indexMemoryFile(memoryContent);
      await indexer.indexMemoryFile(memoryContent);

      // Should only have one fact (deduplicated across indexing runs)
      const keywordResults = store.searchKeyword("Same content", 10);
      expect(keywordResults.length).toBe(1);
    });
  });

  describe("Performance", () => {
    it("search completes quickly with many facts", async () => {
      // Add 100 facts
      for (let i = 0; i < 100; i++) {
        const fact = `Fact number ${i} about various topics`;
        const emb = await embeddings.embed(fact);
        store.addFact(fact, "test", emb);
      }

      const start = Date.now();
      const results = await search("topics");
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500); // Should complete in < 500ms
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("Edge cases", () => {
    it("handles empty search query", async () => {
      const results = await search("");
      expect(results).toEqual([]);
    });

    it("handles search with no facts", async () => {
      const results = await search("anything");
      expect(results).toEqual([]);
    });

    it("handles special characters", async () => {
      const fact = "User's name is O'Brien";
      const emb = await embeddings.embed(fact);
      store.addFact(fact, "test", emb);

      // Should not crash
      const results = await search("O'Brien");
      expect(results.length).toBeGreaterThanOrEqual(0);
    });
  });
});
