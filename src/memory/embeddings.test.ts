import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node-llama-cpp before importing the module under test
vi.mock("node-llama-cpp", () => {
  const mockVector = new Array(768).fill(0.1);

  const mockCtx = {
    getEmbeddingFor: vi.fn().mockResolvedValue({ vector: mockVector }),
  };

  const mockModel = {
    createEmbeddingContext: vi.fn().mockResolvedValue(mockCtx),
  };

  const mockLlama = {
    loadModel: vi.fn().mockResolvedValue(mockModel),
  };

  return {
    getLlama: vi.fn().mockResolvedValue(mockLlama),
    LlamaLogLevel: { warn: 3, error: 4, fatal: 5 },
    resolveModelFile: vi.fn().mockResolvedValue("/fake/path/model.gguf"),
  };
});

// Import after mocking
const { embed, embedBatch } = await import("./embeddings.js");

describe("embeddings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns embedding vector", async () => {
    const result = await embed("hello world");
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBeGreaterThan(0);
  });

  it("throws on empty input", async () => {
    await expect(embed("")).rejects.toThrow("Embedding input is empty");
    await expect(embed("   ")).rejects.toThrow("Embedding input is empty");
  });

  it("embedBatch returns one vector per text", async () => {
    const result = await embedBatch(["one", "two", "three"]);
    expect(result).toHaveLength(3);
    for (const vec of result) {
      expect(Array.isArray(vec)).toBe(true);
    }
  });

  it("embedBatch returns empty array for empty input", async () => {
    const result = await embedBatch([]);
    expect(result).toEqual([]);
  });

  it("embedBatch throws if any text is empty", async () => {
    await expect(embedBatch(["valid", ""])).rejects.toThrow("Embedding input is empty");
  });
});
