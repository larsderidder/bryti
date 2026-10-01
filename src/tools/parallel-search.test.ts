import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createParallelTools } from "./parallel-search.js";
import { lookup } from "node:dns/promises";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

const searchInput = { objective: "Find the official Calendar sync documentation", search_queries: ["Calendar incremental sync"] };
const payload = {
  results: [{ title: "Calendar sync", url: "https://developers.google.com/calendar/sync", excerpts: ["Use nextSyncToken for incremental synchronization."] }],
};

/** Exercise the real native MCP client against an in-memory HTTP endpoint. */
function mockServer(toolResult: unknown = { structuredContent: payload, content: [] }) {
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body));
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
      return new Response(null, { status: 202 });
    }
    let result = toolResult;
    if (message.method === "initialize") {
      result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Parallel anonymous tools", () => {
  beforeEach(() => {
    mockServer();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("exposes only search and extraction, without arbitrary MCP access", () => {
    expect(createParallelTools().map((tool) => tool.name)).toEqual(["parallel_search", "parallel_fetch"]);
  });

  it("uses the fixed HTTPS endpoint anonymously and labels results untrusted", async () => {
    const fetchMock = mockServer();
    const [search] = createParallelTools();
    const result = await search.execute("search", searchInput);
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("untrusted") }]);
    expect(result.details).toMatchObject({ provider: "parallel-free", results: payload.results, untrusted: true });
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe("https://search.parallel.ai/mcp");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
    }
  });

  it("keeps an opaque identifier stable within a tool set and isolated between tool sets", async () => {
    const fetchMock = mockServer();
    const [search, extract] = createParallelTools();
    await search.execute("one", searchInput);
    await extract.execute("two", { urls: ["https://example.com/page"] });
    await createParallelTools()[0].execute("three", searchInput);
    const calls = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
      .filter((message) => message.method === "tools/call");
    expect(calls[0].params.arguments.session_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(calls[0].params.arguments.session_id).toBe(calls[1].params.arguments.session_id);
    expect(calls[2].params.arguments.session_id).not.toBe(calls[0].params.arguments.session_id);
    expect(calls[0].params.name).toBe("web_search");
    expect(calls[1].params.name).toBe("web_fetch");
    expect(calls[1].params.arguments.full_content).toBe(false);
    expect(calls[0].params.arguments).not.toHaveProperty("model_name");
  });

  it("accepts JSON text when structured results are absent", async () => {
    mockServer({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    expect((await createParallelTools()[0].execute("search", searchInput)).details).toMatchObject(payload);
  });

  it.each([
    { structuredContent: { results: "wrong" }, content: [] },
    { content: [{ type: "text", text: "not JSON" }] },
    { isError: true, content: [{ type: "text", text: "backend failure" }] },
    { structuredContent: { results: [{ title: "bad", url: "file:///etc/passwd", excerpts: ["bad"] }] }, content: [] },
    { structuredContent: { results: [{ title: "bad", url: "https://example.com", excerpts: [123] }] }, content: [] },
  ])("reports malformed or failed tool results instead of successful evidence", async (toolResult) => {
    mockServer(toolResult);
    expect((await createParallelTools()[0].execute("search", searchInput)).isError).toBe(true);
  });

  it("reports HTTP rate limits without retrying or changing the session identifier", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createParallelTools()[0].execute("search", searchInput);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("web_search") }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds large excerpts and reports truncation", async () => {
    mockServer({ structuredContent: { results: [{ ...payload.results[0], excerpts: ["x".repeat(100_000)] }] }, content: [] });
    const result = await createParallelTools()[0].execute("search", searchInput);
    const text = result.content.find((block) => block.type === "text");
    expect(text?.type === "text" && text.text.length).toBeLessThanOrEqual(25_000);
    expect(result.details).toMatchObject({ truncated: true });
  });

  it.each(["http://example.com", "https://localhost/a", "https://127.0.0.1/a", "https://10.0.0.1/a", "https://name:password@example.com/a"])("blocks unsafe extraction URLs before contacting Parallel: %s", async (url) => {
    const fetchMock = mockServer();
    expect((await createParallelTools()[1].execute("fetch", { urls: [url] })).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps partial extraction failures visible", async () => {
    mockServer({ structuredContent: { ...payload, errors: [{ url: "https://example.com/missing", error: "not found" }] }, content: [] });
    const result = await createParallelTools()[1].execute("fetch", { urls: ["https://example.com/page", "https://example.com/missing"] });
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({ failureCount: 1 });
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("not found") }]);
  });

  it("marks an entirely failed extraction as an error", async () => {
    mockServer({ structuredContent: { results: [], errors: [{ url: "https://example.com/missing", error: "not found" }] }, content: [] });
    expect((await createParallelTools()[1].execute("fetch", { urls: ["https://example.com/missing"] })).isError).toBe(true);
  });

  it("does not send anything after caller cancellation", async () => {
    const fetchMock = mockServer();
    const controller = new AbortController();
    controller.abort();
    await expect(createParallelTools()[0].execute("search", searchInput, controller.signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds DNS validation within the total extraction timeout", async () => {
    vi.mocked(lookup).mockImplementationOnce(() => new Promise(() => {}));
    const fetchMock = mockServer();
    const pending = createParallelTools({ timeoutMs: 25 })[1].execute("fetch", { urls: ["https://example.com/page"] });
    const outcome = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("stalled"), 100))]);
    expect(outcome).not.toBe("stalled");
    expect(outcome).toMatchObject({ isError: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels oversized HTTP error bodies", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(9000));
      },
      cancel: cancelled,
    }), { status: 500 })));
    expect((await createParallelTools()[0].execute("search", searchInput)).isError).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("aborts a stalled handshake within the total timeout", async () => {
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createParallelTools({ timeoutMs: 25 })[0].execute("search", searchInput);
    expect(result.isError).toBe(true);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
