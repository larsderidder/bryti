/**
 * Tests for the embedding provider.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";

describe("EmbeddingProvider", () => {
  let provider: EmbeddingProvider;

  afterEach(() => {
    provider?.close();
  });

  describe("local provider", () => {
    beforeEach(async () => {
      provider = await createEmbeddingProvider({
        type: "local",
        modelPath: "./models",
      });
    });

    it("creates a provider with correct dimensions", () => {
      expect(provider.dims).toBe(768);
    });

    it("reports ready status", () => {
      expect(provider.ready).toBe(true);
    });

    it("generates embeddings for single text", async () => {
      const embedding = await provider.embed("Hello, world!");
      
      expect(embedding).toBeDefined();
      expect(embedding).toHaveLength(768);
      
      // Check all values are numbers
      embedding.forEach(val => {
        expect(typeof val).toBe("number");
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(1);
      });
    });

    it("generates embeddings for batch of texts", async () => {
      const texts = ["Hello", "World", "Test"];
      const embeddings = await provider.embedBatch(texts);
      
      expect(embeddings).toHaveLength(3);
      embeddings.forEach(emb => {
        expect(emb).toHaveLength(768);
      });
    });

    it("generates deterministic embeddings", async () => {
      const text = "This is a test";
      const emb1 = await provider.embed(text);
      const emb2 = await provider.embed(text);
      
      // Should be identical (or very close due to floating point)
      emb1.forEach((val, i) => {
        expect(val).toBeCloseTo(emb2[i], 10);
      });
    });

    it("generates different embeddings for different text", async () => {
      const emb1 = await provider.embed("Hello");
      const emb2 = await provider.embed("World");
      
      // Calculate cosine similarity
      const dotProduct = emb1.reduce((sum, v, i) => sum + v * emb2[i], 0);
      expect(dotProduct).not.toBe(1); // Not identical
    });

    it("handles empty string", async () => {
      const embedding = await provider.embed("");
      expect(embedding).toHaveLength(768);
    });

    it("handles unicode text", async () => {
      const embedding = await provider.embed("こんにちは世界");
      expect(embedding).toHaveLength(768);
    });

    it("handles long text", async () => {
      const longText = "A".repeat(10000);
      const embedding = await provider.embed(longText);
      expect(embedding).toHaveLength(768);
    });

    it("normalizes embeddings to unit vectors", async () => {
      const embedding = await provider.embed("Test text");
      const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 2);
    });
  });

  describe("close", () => {
    it("sets ready to false after close", async () => {
      provider = await createEmbeddingProvider({ type: "local" });
      expect(provider.ready).toBe(true);
      
      provider.close();
      expect(provider.ready).toBe(false);
    });

    it("throws error on embed after close", async () => {
      provider = await createEmbeddingProvider({ type: "local" });
      provider.close();
      
      await expect(provider.embed("test")).rejects.toThrow("not ready");
    });
  });
});
