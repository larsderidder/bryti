import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parallelApiKey, parallelExtract, parallelSearch } from "./parallel-api.js";
import { fetchPage } from "./web-fetch.js";

vi.mock("axios", async () => {
  const original = await vi.importActual<typeof import("axios")>("axios");
  return { ...original, default: { ...original.default, post: vi.fn(), get: vi.fn() } };
});
const post = vi.mocked(axios.post);
const get = vi.mocked(axios.get);
const page = { url: "https://93.184.216.34/guide", title: "Guide", excerpts: ["Useful evidence"] };
const options = () => ({ access: "authenticated" as const, apiKey: `fixture-${randomUUID()}` });
const response = (data: unknown, status = 200) => ({ data, status, headers: {} }) as Awaited<ReturnType<typeof axios.post>>;

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("authenticated Parallel API", () => {
  it("batches query variants in one authenticated bounded request", async () => {
    post.mockResolvedValue(response({ results: [page], search_id: "search-fixture" }));
    const opts = options();
    const result = await parallelSearch({ queries: ["Dutch policy", "Nederland beleid"], includeDomains: ["overheid.nl"] }, opts);
    expect(result.results[0].excerpts).toEqual(["Useful evidence"]);
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0][0]).toBe("https://api.parallel.ai/v1/search");
    expect(post.mock.calls[0][1]).toMatchObject({ search_queries: ["Dutch policy", "Nederland beleid"], advanced_settings: { source_policy: { include_domains: ["overheid.nl"] } } });
    expect(post.mock.calls[0][2]).toMatchObject({ headers: { "x-api-key": opts.apiKey }, maxRedirects: 0, proxy: false, maxContentLength: 2097152 });
  });

  it("does not expose transport errors containing credentials", async () => {
    const opts = options();
    post.mockRejectedValue(new Error(`transport headers contained ${opts.apiKey}`));
    await expect(parallelSearch({ queries: ["query"] }, opts)).rejects.toThrow("Parallel request failed or timed out");
  });

  it("shares the request ceiling across search and extraction", async () => {
    post.mockResolvedValue(response({ results: [page] }));
    const opts = { ...options(), maxRequestsPerHour: 1 };
    await parallelSearch({ queries: ["query"] }, opts);
    await expect(parallelExtract(page.url, opts)).rejects.toThrow("request ceiling");
    expect(post).toHaveBeenCalledOnce();
  });

  it("observes provider cooldown without retrying a throttled call", async () => {
    post.mockResolvedValue(response({}, 429));
    const opts = options();
    await expect(parallelSearch({ queries: ["query"] }, opts)).rejects.toThrow("HTTP 429");
    await expect(parallelSearch({ queries: ["query"] }, opts)).rejects.toThrow("cooldown");
    expect(post).toHaveBeenCalledOnce();
  });

  it("does not issue a call after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(parallelSearch({ queries: ["query"] }, { ...options(), signal: controller.signal })).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects malformed results and extraction errors", async () => {
    post.mockResolvedValue(response({ results: [{ ...page, excerpts: [null] }] }));
    await expect(parallelSearch({ queries: ["query"] }, options())).rejects.toThrow("invalid result fields");
    post.mockResolvedValue(response({ results: [{ ...page, full_content: "Evidence" }], errors: [{ url: page.url }] }));
    await expect(parallelExtract(page.url, options())).rejects.toThrow("extraction failed");
  });

  it("requires private operator credential files", () => {
    vi.stubEnv("PARALLEL_API_KEY", "");
    const dir = mkdtempSync(join(tmpdir(), "parallel-key-test-"));
    const path = join(dir, "api-key");
    try {
      writeFileSync(path, "fixture-key", { mode: 0o644 });
      expect(() => parallelApiKey({ apiKeyFile: path })).toThrow("private");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("uses hosted extraction only after unusable direct content, without inventing target status", async () => {
    get.mockResolvedValue(response("Denied", 403));
    post.mockResolvedValue(response({ results: [{ ...page, full_content: "# Guide\n\nEvidence" }], errors: [] }));
    const result = await fetchPage(page.url, { parallel: { enabled: true, ...options() } });
    expect(result.extractor).toBe("parallel");
    expect(result.status).toBeUndefined();
    expect(result.warning).toMatch(/Target HTTP status.*final redirect URL.*freshness.*unverified/);
  });

  it("does not forward 404s or private targets to paid extraction", async () => {
    get.mockResolvedValue(response("Not found", 404));
    await expect(fetchPage(page.url, { parallel: { enabled: true, ...options() } })).rejects.toThrow("404");
    await expect(fetchPage("https://127.0.0.1/", { parallel: { enabled: true, ...options() } })).rejects.toThrow("private");
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    { name: "empty result", results: [], error: "returned no results" },
    { name: "different URL", results: [{ ...page, url: "https://example.com/other", full_content: "Evidence" }], error: "URL mismatch" },
    { name: "missing content", results: [page], error: "no full content for the matching URL" },
  ])("distinguishes an extraction $name", async ({ results, error }) => {
    post.mockResolvedValue(response({ results, errors: [] }));
    await expect(parallelExtract(page.url, options())).rejects.toThrow(error);
  });
});
