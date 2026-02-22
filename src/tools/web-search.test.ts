/**
 * Tests for web search tool backends.
 *
 * Uses https mock to avoid real network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBraveSearchTool, createWebSearchTool } from "./web-search.js";

// ---------------------------------------------------------------------------
// Mock node:https
// ---------------------------------------------------------------------------

vi.mock("node:https", () => {
  return {
    default: {
      get: vi.fn(),
    },
    get: vi.fn(),
  };
});

import https from "node:https";
const mockedHttps = vi.mocked(https);

type FakeRes = {
  on: (event: string, handler: (...args: any[]) => void) => FakeRes;
};

function mockHttpsResponse(body: unknown, statusCode = 200): void {
  const json = JSON.stringify(body);
  mockedHttps.get = vi.fn().mockImplementation((_opts, callback) => {
    const res: FakeRes = { on: vi.fn() };
    const handlers = new Map<string, ((...args: any[]) => void)[]>();

    res.on = vi.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return res;
    });

    // Simulate async response
    setImmediate(() => {
      callback(res as any);
      for (const h of handlers.get("data") ?? []) {
        h(Buffer.from(json));
      }
      for (const h of handlers.get("end") ?? []) {
        h();
      }
    });

    return { on: vi.fn(), destroy: vi.fn() } as any;
  });
}

function mockHttpsError(message: string): void {
  mockedHttps.get = vi.fn().mockImplementation((_opts, _callback) => {
    const req = { on: vi.fn(), destroy: vi.fn() } as any;
    setImmediate(() => {
      const errorHandlers: Array<(err: Error) => void> = [];
      req.on = vi.fn((event: string, handler: (err: Error) => void) => {
        if (event === "error") errorHandlers.push(handler);
        return req;
      });
      // Trigger error on the real req object after on() is registered
    });
    // Simpler: call error immediately on the returned req
    const handlers: Record<string, ((...args: any[]) => void)[]> = {};
    const req2 = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
        return req2;
      }),
      destroy: vi.fn(),
    };
    setImmediate(() => {
      for (const h of handlers["error"] ?? []) {
        h(new Error(message));
      }
    });
    return req2 as any;
  });
}

// ---------------------------------------------------------------------------
// Brave Search tests
// ---------------------------------------------------------------------------

describe("createBraveSearchTool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns tool with name web_search", () => {
    const tool = createBraveSearchTool("test-key");
    expect(tool.name).toBe("web_search");
  });

  it("maps Brave results to standard shape", async () => {
    mockHttpsResponse({
      web: {
        results: [
          { title: "Result A", url: "https://a.com", description: "Snippet A" },
          { title: "Result B", url: "https://b.com", description: "Snippet B" },
        ],
      },
    });

    const tool = createBraveSearchTool("test-key");
    const result = await tool.execute("id", { query: "test query" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toEqual({
      title: "Result A",
      url: "https://a.com",
      snippet: "Snippet A",
      engine: "brave",
    });
  });

  it("respects count parameter", async () => {
    mockHttpsResponse({
      web: {
        results: Array.from({ length: 10 }, (_, i) => ({
          title: `Result ${i}`,
          url: `https://result${i}.com`,
          description: `Snippet ${i}`,
        })),
      },
    });

    const tool = createBraveSearchTool("test-key");
    const result = await tool.execute("id", { query: "test", count: 3 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toHaveLength(3);
  });

  it("maps freshness values to Brave format", async () => {
    let capturedUrl = "";
    mockedHttps.get = vi.fn().mockImplementation((opts, callback) => {
      capturedUrl = `https://${opts.hostname}${opts.path}`;
      const res = { on: vi.fn() };
      const handlers = new Map<string, ((...args: any[]) => void)[]>();
      res.on = vi.fn((event, handler) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
        return res;
      });
      setImmediate(() => {
        callback(res);
        for (const h of handlers.get("data") ?? []) h(Buffer.from(JSON.stringify({ web: { results: [] } })));
        for (const h of handlers.get("end") ?? []) h();
      });
      return { on: vi.fn(), destroy: vi.fn() };
    });

    const tool = createBraveSearchTool("test-key");
    await tool.execute("id", { query: "news", freshness: "week" });

    expect(capturedUrl).toContain("freshness=pw");
  });

  it("passes through Brave-native freshness codes unchanged", async () => {
    let capturedUrl = "";
    mockedHttps.get = vi.fn().mockImplementation((opts, callback) => {
      capturedUrl = `https://${opts.hostname}${opts.path}`;
      const res = { on: vi.fn() };
      const handlers = new Map<string, ((...args: any[]) => void)[]>();
      res.on = vi.fn((event, handler) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
        return res;
      });
      setImmediate(() => {
        callback(res);
        for (const h of handlers.get("data") ?? []) h(Buffer.from(JSON.stringify({ web: { results: [] } })));
        for (const h of handlers.get("end") ?? []) h();
      });
      return { on: vi.fn(), destroy: vi.fn() };
    });

    const tool = createBraveSearchTool("test-key");
    await tool.execute("id", { query: "news", freshness: "pd" });

    expect(capturedUrl).toContain("freshness=pd");
  });

  it("handles empty results gracefully", async () => {
    mockHttpsResponse({ web: { results: [] } });

    const tool = createBraveSearchTool("test-key");
    const result = await tool.execute("id", { query: "nothing" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toEqual([]);
  });

  it("handles missing web field gracefully", async () => {
    mockHttpsResponse({});

    const tool = createBraveSearchTool("test-key");
    const result = await tool.execute("id", { query: "nothing" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results).toEqual([]);
  });

  it("returns error on network failure", async () => {
    mockHttpsError("ECONNREFUSED");

    const tool = createBraveSearchTool("test-key");
    const result = await tool.execute("id", { query: "test" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toMatch(/ECONNREFUSED/);
  });

  it("truncates long snippets to 300 chars", async () => {
    const longDescription = "x".repeat(500);
    mockHttpsResponse({
      web: {
        results: [{ title: "T", url: "https://t.com", description: longDescription }],
      },
    });

    const tool = createBraveSearchTool("test-key");
    const result = await tool.execute("id", { query: "test" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results[0].snippet).toHaveLength(300);
  });
});

// ---------------------------------------------------------------------------
// SearXNG tool — minimal smoke test (existing functionality, not regressed)
// ---------------------------------------------------------------------------

describe("createWebSearchTool (SearXNG)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns tool with name web_search", () => {
    const tool = createWebSearchTool("https://searx.example.com");
    expect(tool.name).toBe("web_search");
  });
});
