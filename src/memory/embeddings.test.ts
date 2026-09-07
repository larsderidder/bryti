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
const { configureEmbeddings, embeddingsAvailable, embed, embedBatch, warmupEmbeddings } = await import("./embeddings.js");

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

  it("returns null for optional OpenAI-compatible HTTP failures without raw response logging", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "raw-provider-detail",
    } as Response);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    configureEmbeddings({
      provider: "openai-compatible",
      base_url: "http://127.0.0.1:11434/v1/",
      api_key: "api-key-placeholder",
      model: "nomic-embed-text",
      timeout_ms: 10000,
    });

    const first = await embed("hello", undefined, "query");
    const second = await embed("hello again", undefined, "query");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const warnings = warn.mock.calls.map(([message]) => String(message)).join("\n");
    expect(warnings).toContain("Embedding provider degraded (remote request failed)");
    expect(warnings).not.toContain("raw-provider-detail");
    expect(warnings).not.toContain("api-key-placeholder");
  });

  it("recovers optional OpenAI-compatible embeddings after a remote outage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.4, 0.5, 0.6] }] }),
      } as Response);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    configureEmbeddings({
      provider: "openai-compatible",
      base_url: "http://127.0.0.1:11434/v1/",
      model: "nomic-embed-text",
      timeout_ms: 10000,
    });

    const first = await embed("hello", undefined, "query");
    const second = await embed("hello again", undefined, "query");

    expect(first).toBeNull();
    expect(second).toEqual([0.4, 0.5, 0.6]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resets remote availability when configuration changes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 502,
    } as Response);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    configureEmbeddings({
      provider: "openai-compatible",
      base_url: "http://127.0.0.1:11434/v1/",
      model: "nomic-embed-text",
      timeout_ms: 10000,
    });

    await embed("hello", undefined, "query");
    expect(embeddingsAvailable()).toBe(false);

    configureEmbeddings({
      provider: "openai-compatible",
      base_url: "http://127.0.0.1:11435/v1/",
      model: "nomic-embed-text-v2",
      timeout_ms: 10000,
    });

    expect(embeddingsAvailable()).toBe(true);
  });

  it("returns null for optional OpenAI-compatible timeouts", async () => {
    const timeoutError = new Error("provider timeout detail");
    timeoutError.name = "AbortError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    configureEmbeddings({
      provider: "openai-compatible",
      base_url: "http://127.0.0.1:11434/v1/",
      model: "nomic-embed-text",
      timeout_ms: 10000,
    });

    const result = await embed("hello", undefined, "query");

    expect(result).toBeNull();
    const warnings = warn.mock.calls.map(([message]) => String(message)).join("\n");
    expect(warnings).toContain("Embedding provider degraded (remote request timed out)");
    expect(warnings).not.toContain("provider timeout detail");
  });

  it("rejects OpenAI-compatible failures when embeddings are required", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "raw-provider-detail",
    } as Response);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    configureEmbeddings({
      provider: "openai-compatible",
      base_url: "http://127.0.0.1:11434/v1/",
      model: "nomic-embed-text",
      timeout_ms: 10000,
      required: true,
    });

    await expect(embed("hello", undefined, "query")).rejects.toThrow(
      "Embedding provider is required but unavailable",
    );
    await expect(embed("hello again", undefined, "query")).rejects.toThrow(
      "Embedding provider is required but unavailable",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("verifies required OpenAI-compatible warmup through the embedding endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    } as Response);
    configureEmbeddings({
      provider: "openai-compatible",
      base_url: "http://127.0.0.1:11434/v1/",
      model: "nomic-embed-text",
      timeout_ms: 10000,
      required: true,
    });

    await warmupEmbeddings();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/embeddings",
      expect.objectContaining({
        body: JSON.stringify({ model: "nomic-embed-text", input: "embedding warmup" }),
      }),
    );
  });
});
