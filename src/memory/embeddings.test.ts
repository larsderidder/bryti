import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { embed, embedBatch } from "./embeddings.js";

describe("embeddings", () => {
  const apiKey = "test-key";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns embedding vector of expected length", async () => {
    const embedding = new Array(768).fill(0.1);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await embed("hello world", apiKey);

    expect(result).toHaveLength(768);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("supports batch embeddings", async () => {
    const embeddingA = new Array(768).fill(0.2);
    const embeddingB = new Array(768).fill(0.3);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: embeddingA }, { embedding: embeddingB }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await embedBatch(["one", "two"], apiKey);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(768);
  });

  it("throws on empty input", async () => {
    await expect(embed("", apiKey)).rejects.toThrow("Embedding input is empty");
  });

  it("throws on API error response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(embed("hello", apiKey)).rejects.toThrow("Embedding API error: 401 Unauthorized");
  });

  it("throws on network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(embed("hello", apiKey)).rejects.toThrow(
      "Embedding API request failed: Network down",
    );
  });

  it("throws on timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, options: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = options.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener("abort", () => {
            const error = new Error("Aborted");
            error.name = "AbortError";
            reject(error);
          });
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = embed("hello", apiKey);
    const expectation = expect(promise).rejects.toThrow("Embedding API request timed out");

    await vi.advanceTimersByTimeAsync(15000);
    await expectation;
  });
});
