/**
 * Web search tools for workers.
 *
 * Two backends exist because they serve different deployment needs:
 *
 *   Brave Search — hosted SaaS, single API key, 2000 free queries/month.
 *                  Good default: no infrastructure to run.
 *
 *   SearXNG     — self-hosted metasearch engine that aggregates Google, Bing,
 *                 DuckDuckGo, Brave, and many others in one query. More sources,
 *                 no per-query cost, but requires a running SearXNG instance.
 *                 Preferred when the user controls their own instance (privacy,
 *                 higher volume, or aggregated coverage matters more than setup
 *                 cost).
 *
 * Workers use this by default. The main agent only gets this tool when the
 * operator opts into the `web` tool group.
 *
 * Selection logic:
 *   - brave_api_key set -> Brave Search
 *   - searxng_url set  -> SearXNG
 *   - neither          -> web search disabled
 */

import https from "node:https";
import http from "node:http";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { Type } from "typebox";
import { fetchSearxngJson, parseSearxngResults, searxngEndpoint, type SearxngOptions } from "./searxng.js";


const webSearchSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (default: 10, max: 20)",
      minimum: 1,
      maximum: 20,
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        'Time filter: "day", "week", "month", "year"',
    }),
  ),
  language: Type.Optional(
    Type.String({
      description: 'Result language (e.g., "en", "nl", "de"). Default: "en".',
    }),
  ),
});

type WebSearchInput = Static<typeof webSearchSchema>;


// ---------------------------------------------------------------------------
// Brave Search backend
// ---------------------------------------------------------------------------

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  page_age?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
  query?: {
    original?: string;
  };
}

/**
 * Fetch from Brave Search API using Node https (no axios dependency,
 * keeps parity with the SearXNG implementation).
 */
function fetchBraveJson(
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<BraveSearchResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      timeout: timeoutMs,
    };

    const req = https.get(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()) as BraveSearchResponse);
        } catch (err) {
          reject(new Error(`Failed to parse Brave response: ${(err as Error).message}`));
        }
      });
    });

    req.on("error", (err: Error) => {
      reject(new Error(`Brave Search request failed: ${err.message}`));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Brave Search request timed out"));
    });
  });
}

/**
 * Create the web search tool backed by Brave Search API.
 *
 * Brave free tier: 2000 queries/month, no credit card required.
 * Docs: https://api.search.brave.com/
 */
export function createBraveSearchTool(apiKey: string): AgentTool<typeof webSearchSchema> {
  return {
    name: "web_search",
    label: "web_search",
    description:
      "Search the web using Brave Search. Returns titles, URLs, and snippets.",
    parameters: webSearchSchema,
    async execute(
      _toolCallId: string,
      { query, count, freshness, language }: WebSearchInput,
    ): Promise<AgentToolResult<unknown>> {
      const limit = Math.min(count ?? 10, 20);

      const params = new URLSearchParams({
        q: query,
        count: String(limit),
      });

      if (language) {
        params.set("search_lang", language);
      }

      if (freshness) {
        // Brave freshness values: pd, pw, pm, py
        const timeMap: Record<string, string> = {
          day: "pd",
          week: "pw",
          month: "pm",
          year: "py",
          pd: "pd",
          pw: "pw",
          pm: "pm",
          py: "py",
        };
        const bf = timeMap[freshness];
        if (bf) params.set("freshness", bf);
      }

      const url = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;

      try {
        const response = await fetchBraveJson(url, apiKey, 10000);

        const results = (response.web?.results ?? []).slice(0, limit).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: (r.description ?? "").slice(0, 300),
          engine: "brave",
        }));

        const text = JSON.stringify({ results }, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { query, results, total: results.length },
        };
      } catch (error) {
        const err = error as Error;
        const text = JSON.stringify({ error: `Search failed: ${err.message}` });
        return {
          content: [{ type: "text", text }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SearXNG backend
// ---------------------------------------------------------------------------

/** Create a bounded, cancellable SearXNG search tool with a per-instance cache. */
export function createWebSearchTool(searxngUrl: string, options: SearxngOptions = {}): AgentTool<typeof webSearchSchema> {
  const endpoint = searxngEndpoint(searxngUrl);
  const cache = new Map<string, { expiresAt: number; response: ReturnType<typeof parseSearxngResults> }>();
  const ttl = options.cacheTtlMs ?? 30_000;
  const maxEntries = options.maxCacheEntries ?? 100;
  return {
    name: "web_search",
    label: "web_search",
    description: "Search the web. Returns titles, URLs, and untrusted snippets from SearXNG.",
    parameters: webSearchSchema,
    async execute(_toolCallId, { query, count, freshness, language }, signal) {
      signal?.throwIfAborted();
      const limit = Math.min(count ?? 10, 20);
      const params = new URLSearchParams({ q: query, format: "json", language: language ?? "en", safesearch: "0" });
      if (freshness) {
        const ranges: Record<string, string> = { pd: "day", pw: "week", pm: "month", py: "year" };
        params.set("time_range", ranges[freshness] ?? freshness);
      }
      const url = new URL(endpoint);
      url.search = params.toString();
      const key = JSON.stringify([url.href, limit]);
      try {
        const now = Date.now();
        for (const [cachedKey, entry] of cache) {
          if (entry.expiresAt <= now) {
            cache.delete(cachedKey);
          }
        }
        let cached = false;
        let response = cache.get(key)?.response;
        if (response) {
          cached = true;
        } else {
          response = parseSearxngResults(await fetchSearxngJson(url, options, signal), limit);
          signal?.throwIfAborted();
          if (ttl > 0 && maxEntries > 0) {
            while (cache.size >= maxEntries) {
              cache.delete(cache.keys().next().value!);
            }
            cache.set(key, { expiresAt: Date.now() + ttl, response: structuredClone(response) });
          }
        }
        response = structuredClone(response);
        return {
          content: [{ type: "text", text: JSON.stringify({ results: response.results }, null, 2) }],
          details: { query, ...response, cached, untrusted: true },
        };
      } catch (error) {
        signal?.throwIfAborted();
        let message = "Search failed";
        if (error instanceof Error) {
          message = `Search failed: ${error.message}`;
        }
        return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], details: { error: message }, isError: true };
      }
    },
  };
}
