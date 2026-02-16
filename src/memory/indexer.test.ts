/**
 * Tests for memory indexer.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { chunkText, computeHash, createIndexer } from "./indexer.js";
import type { MemoryStore } from "./store.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { ChatMessage } from "../history.js";

describe("MemoryIndexer", () => {
  describe("chunkText", () => {
    it("chunks markdown on headers", () => {
      const text = `# Preferences
Likes coffee

# Work
Freelancer`;

      const chunks = chunkText(text);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toContain("Preferences");
      expect(chunks[0]).toContain("Likes coffee");
      expect(chunks[1]).toContain("Work");
      expect(chunks[1]).toContain("Freelancer");
    });

    it("handles nested headers", () => {
      const text = `# Main
## Sub
Content`;

      const chunks = chunkText(text);

      // Should keep nested sections together
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("handles empty content", () => {
      const chunks = chunkText("");
      expect(chunks).toEqual([]);
    });

    it("handles whitespace-only content", () => {
      const chunks = chunkText("   \n\n   ");
      expect(chunks).toEqual([]);
    });

    it("handles plain text without headers", () => {
      const text = `This is a paragraph.
This is another paragraph.`;

      const chunks = chunkText(text);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("computeHash", () => {
    it("produces consistent hashes", () => {
      const hash1 = computeHash("test content");
      const hash2 = computeHash("test content");

      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different content", () => {
      const hash1 = computeHash("content 1");
      const hash2 = computeHash("content 2");

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("createIndexer", () => {
    const createMockStore = (): MemoryStore => ({
      addFact: vi.fn().mockReturnValue("fact-id"),
      removeFact: vi.fn(),
      searchKeyword: vi.fn().mockReturnValue([]),
      searchVector: vi.fn().mockReturnValue([]),
      getAllFacts: vi.fn().mockReturnValue([]),
      close: vi.fn(),
    });

    const createMockEmbeddingProvider = (): EmbeddingProvider => ({
      embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
      embedBatch: vi.fn(),
      dims: 768,
      ready: true,
      providerName: "mock",
      close: vi.fn(),
    });

    describe("indexMemoryFile", () => {
      it("indexes markdown content", async () => {
        const store = createMockStore();
        const embeddings = createMockEmbeddingProvider();
        const { indexMemoryFile } = createIndexer(store, embeddings);

        const content = `# Preferences
Likes coffee

# Work
Freelancer`;

        await indexMemoryFile(content);

        expect(store.addFact).toHaveBeenCalledTimes(2);
      });

      it("skips unchanged content on re-index", async () => {
        const store = createMockStore();
        const embeddings = createMockEmbeddingProvider();
        const { indexMemoryFile } = createIndexer(store, embeddings);

        const content = `# Test
Content here`;

        // First indexing
        await indexMemoryFile(content);
        const firstCallCount = store.addFact.mock.calls.length;

        // Second indexing with same content
        await indexMemoryFile(content);
        const secondCallCount = store.addFact.mock.calls.length;

        // Should not add more facts
        expect(secondCallCount).toBe(firstCallCount);
      });

      it("adds new content on re-index", async () => {
        const store = createMockStore();
        const embeddings = createMockEmbeddingProvider();
        const { indexMemoryFile } = createIndexer(store, embeddings);

        const contentA = `# Test
Content A`;
        const contentB = `# Test
Content B`;

        await indexMemoryFile(contentA);
        const firstCallCount = store.addFact.mock.calls.length;

        await indexMemoryFile(contentB);
        const secondCallCount = store.addFact.mock.calls.length;

        // Should have added the new content
        expect(secondCallCount).toBeGreaterThan(firstCallCount);
      });

      it("handles empty content", async () => {
        const store = createMockStore();
        const embeddings = createMockEmbeddingProvider();
        const { indexMemoryFile } = createIndexer(store, embeddings);

        await indexMemoryFile("");

        expect(store.addFact).not.toHaveBeenCalled();
      });
    });

    describe("indexConversation", () => {
      it("indexes conversation messages", async () => {
        const store = createMockStore();
        const embeddings = createMockEmbeddingProvider();
        const { indexConversation } = createIndexer(store, embeddings);

        const messages: ChatMessage[] = [
          { role: "user", content: "My email is lars@example.com" },
          { role: "assistant", content: "I'll remember that" },
        ];

        await indexConversation(messages);

        expect(store.addFact).toHaveBeenCalledTimes(2);
      });

      it("skips system messages", async () => {
        const store = createMockStore();
        const embeddings = createMockEmbeddingProvider();
        const { indexConversation } = createIndexer(store, embeddings);

        const messages: ChatMessage[] = [
          { role: "system", content: "System message" },
          { role: "user", content: "User message" },
        ];

        await indexConversation(messages);

        // Only user message should be indexed
        expect(store.addFact).toHaveBeenCalledTimes(1);
      });

      it("skips duplicate messages", async () => {
        const store = createMockStore();
        const embeddings = createMockEmbeddingProvider();
        const { indexConversation } = createIndexer(store, embeddings);

        const messages: ChatMessage[] = [
          { role: "user", content: "Same message" },
        ];

        await indexConversation(messages);
        await indexConversation(messages);

        // Should only be indexed once
        expect(store.addFact).toHaveBeenCalledTimes(1);
      });
    });
  });
});
