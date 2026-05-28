import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
const { configureEmbeddings, embed, embedBatch } = await import("./embeddings.js");

describe("embeddings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureEmbeddings({ provider: "local", timeout_ms: 10000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("calls OpenAI-compatible embedding endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    } as Response);
    configureEmbeddings({
      provider: "openai-compatible",
      base_url: "http://127.0.0.1:11434/v1/",
      api_key: "test-key",
      model: "nomic-embed-text",
      query_input_type: "query",
      document_input_type: "document",
      timeout_ms: 10000,
    });

    const result = await embed("hello", undefined, "query");

    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-key" }),
        body: JSON.stringify({ model: "nomic-embed-text", input: "hello", input_type: "query" }),
      }),
    );
  });
});
