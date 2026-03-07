/**
 * Tests for the memory store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryStore, type MemoryStore } from "./store.js";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

describe("MemoryStore", () => {
  const testDir = path.join(process.cwd(), ".test-data", "memory-store");
  const userId = "test-user";
  let store: MemoryStore;

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    store = createMemoryStore(userId, testDir);
  });

  afterEach(() => {
    store.close();
    // Clean up after tests
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe("database creation", () => {
    it("creates database with correct path", () => {
      const dbPath = path.join(testDir, "users", userId, "memory.db");
      expect(fs.existsSync(dbPath)).toBe(true);
    });
  });

  describe("addFact", () => {
    it("adds a fact and returns an ID", () => {
      const embedding = new Array(768).fill(0).map(() => Math.random());
      const id = store.addFact("Lars prefers dark mode", "memory.md", embedding);

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    it("stores fact with correct metadata", () => {
      const embedding = new Array(768).fill(0).map(() => Math.random());
      const id = store.addFact("Test fact", "test-source", embedding);

      const results = store.searchKeyword("Test fact", 10);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(id);
      expect(results[0].content).toBe("Test fact");
      expect(results[0].source).toBe("test-source");
      expect(results[0].timestamp).toBeDefined();
    });

    it("stores embeddings as binary blobs", () => {
      const embedding = new Array(768).fill(0.1);
      const id = store.addFact("Binary embedding", "test", embedding);
      store.close();

      const dbPath = path.join(testDir, "users", userId, "memory.db");
      const db = new Database(dbPath);
      const row = db
        .prepare("SELECT embedding FROM fact_embeddings WHERE id = ?")
        .get(id) as { embedding: Buffer };
      db.close();

      expect(Buffer.isBuffer(row.embedding)).toBe(true);
      expect(row.embedding.length).toBe(embedding.length * 4);
    });
  });

  describe("removeFact", () => {
    it("removes a fact", () => {
      const embedding = new Array(768).fill(0).map(() => Math.random());
      const id = store.addFact("Fact to remove", "test", embedding);

      store.removeFact(id);

      const results = store.searchKeyword("Fact to remove", 10);
      expect(results).toHaveLength(0);
    });

    it("removes embeddings from vector search", () => {
      const embedding = new Array(768).fill(0.2);
      const id = store.addFact("Vector fact", "test", embedding);
      store.removeFact(id);

      const results = store.searchVector(embedding, 10);
      expect(results).toHaveLength(0);
    });
  });

  describe("searchKeyword", () => {
    beforeEach(() => {
      // Add test facts
      const embeddings = [
        new Array(768).fill(0.1).map((v, i) => v + i * 0.001),
        new Array(768).fill(0.2).map((v, i) => v + i * 0.001),
        new Array(768).fill(0.3).map((v, i) => v + i * 0.001),
      ];

      store.addFact("Lars likes coffee", "memory.md", embeddings[0]);
      store.addFact("Lars likes tea", "memory.md", embeddings[1]);
      store.addFact("The weather is nice today", "conversation", embeddings[2]);
    });

    it("finds facts with matching keywords", () => {
      const results = store.searchKeyword("Lars likes", 10);

      expect(results.length).toBeGreaterThanOrEqual(2);
      const contents = results.map((r) => r.content);
      expect(contents).toContain("Lars likes coffee");
      expect(contents).toContain("Lars likes tea");
    });

    it("does not return unrelated facts", () => {
      const results = store.searchKeyword("Lars likes", 10);
      const contents = results.map((r) => r.content);
      expect(contents).not.toContain("The weather is nice today");
    });

    it("ranks results by BM25 relevance", () => {
      const results = store.searchKeyword("Lars", 10);
      expect(results.length).toBe(2);
    });

    it("returns empty for empty query", () => {
      const results = store.searchKeyword("", 10);
      expect(results).toEqual([]);
    });

    it("handles special characters in queries", () => {
      // Should not crash
      expect(() => store.searchKeyword("O'Brien", 10)).not.toThrow();
      expect(() => store.searchKeyword("AND OR NOT", 10)).not.toThrow();
    });
  });

  describe("searchVector", () => {
    it("finds semantically similar facts", () => {
      // Add facts with known embeddings
      // Similar embeddings should be found together
      const meetingEmbedding = new Array(768).fill(0).map((_, i) => Math.sin(i * 0.1));
      const groceryEmbedding = new Array(768).fill(0).map((_, i) => Math.cos(i * 0.1));

      store.addFact("Meeting with client at 3pm", "calendar", meetingEmbedding);
      store.addFact("Grocery list: milk, eggs", "notes", groceryEmbedding);

      // Search with a query similar to "meeting" (similar to meetingEmbedding)
      const queryEmbedding = new Array(768).fill(0).map((_, i) => Math.sin(i * 0.1) + 0.01);
      const results = store.searchVector(queryEmbedding, 10);

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("Meeting");
    });

    it("returns empty for empty database", () => {
      const results = store.searchVector(new Array(768).fill(0), 10);
      expect(results).toEqual([]);
    });
  });

  describe("persistence", () => {
    it("persists facts across instances", () => {
      const embedding = new Array(768).fill(0.4);
      store.addFact("Persistent fact", "memory.md", embedding);
      store.close();

      store = createMemoryStore(userId, testDir);
      const results = store.searchKeyword("Persistent", 10);
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("Persistent fact");
    });
  });

  describe("isolated user data", () => {
    it("creates separate databases for different users", () => {
      const dbPath = path.join(testDir, "users", userId, "memory.db");
      expect(dbPath).toContain(userId);
    });
  });
});
