import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createWebSearchTool } from "./web-search.js";
import { parseSearxngResults } from "./searxng.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function endpoint(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture address");
  }
  return `http://127.0.0.1:${address.port}/searx`;
}

function text(result: Awaited<ReturnType<ReturnType<typeof createWebSearchTool>["execute"]>>): string {
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

const payload = { results: [{ title: "Example", url: "https://example.com", content: "Snippet" }] };

describe("SearXNG request boundary", () => {
  it.each([[0, 0], [1, 1], [1.9, 1], [20, 20], [50, 20]])("bounds result count %s to %s", (limit, count) => {
    const results = Array.from({ length: 30 }, () => payload.results[0]);
    expect(parseSearxngResults({ results }, limit).results).toHaveLength(count);
  });

  it("rejects a non-finite result limit", () => {
    expect(() => parseSearxngResults(payload, NaN)).toThrow("result limit");
  });

  it("reports engine failures instead of claiming a confirmed empty search", async () => {
    const base = await endpoint((_request, response) => response.end(JSON.stringify({ results: [], unresponsive_engines: [["google", "timeout"]] })));
    const result = await createWebSearchTool(base).execute("degraded", { query: "query" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not a confirmed no-match result");
  });
  it("caches identical requests and preserves an instance's path prefix", async () => {
    const urls: string[] = [];
    const base = await endpoint((request, response) => {
      urls.push(request.url!);
      response.end(JSON.stringify(payload));
    });
    const tool = createWebSearchTool(base);
    const first = await tool.execute("first", { query: "hello", language: "nl" });
    const second = await tool.execute("second", { query: "hello", language: "nl" });
    expect(JSON.parse(text(first)).results).toEqual(JSON.parse(text(second)).results);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/searx/search?");
    expect(second.details).toMatchObject({ cached: true });
  });

  it("rejects non-success responses without caching them", async () => {
    let calls = 0;
    const base = await endpoint((_request, response) => {
      calls += 1;
      response.writeHead(503);
      response.end(JSON.stringify(payload));
    });
    const tool = createWebSearchTool(base);
    expect(text(await tool.execute("first", { query: "hello" }))).toContain("503");
    expect(text(await tool.execute("second", { query: "hello" }))).toContain("503");
    expect(calls).toBe(2);
  });

  it("terminates a response that exceeds the byte limit", async () => {
    const base = await endpoint((_request, response) => response.end("x".repeat(2048)));
    const result = await createWebSearchTool(base, { maxResponseBytes: 1024 }).execute("large", { query: "hello" });
    expect(text(result)).toContain("byte limit");
  });

  it("cancels the actual request when the caller aborts", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const base = await endpoint((_request, _response) => started());
    const controller = new AbortController();
    const pending = createWebSearchTool(base).execute("cancel", { query: "hello" }, controller.signal);
    await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not serve cached results to an aborted caller", async () => {
    const base = await endpoint((_request, response) => response.end(JSON.stringify(payload)));
    const tool = createWebSearchTool(base);
    await tool.execute("first", { query: "hello" });
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute("cancel", { query: "hello" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("filters malformed results without following result URLs", async () => {
    const base = await endpoint((_request, response) => response.end(JSON.stringify({ results: [
      null, { title: 1, url: "https://example.com" }, { title: "Unsafe", url: "javascript:alert(1)" },
      { title: "Valid", url: "https://example.com", content: { bad: true } },
    ] })));
    const result = await createWebSearchTool(base).execute("malformed", { query: "hello" });
    expect(JSON.parse(text(result)).results).toEqual([{ title: "Valid", url: "https://example.com", snippet: "", engine: "unknown" }]);
  });

  it("rejects a malformed response object", async () => {
    const base = await endpoint((_request, response) => response.end(JSON.stringify({ results: "wrong" })));
    expect(text(await createWebSearchTool(base).execute("malformed", { query: "hello" }))).toContain("Invalid SearXNG response");
  });

  it.each(["file:///tmp/search", "https://user:password@example.com", "https://example.com?token=fixture", "https://example.com/#fragment"])("rejects unsafe endpoint configuration %s", (base) => {
    expect(() => createWebSearchTool(base)).toThrow("SearXNG endpoint");
  });
});
