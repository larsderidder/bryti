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
 * Workers only; the main agent has no access to these tools (security boundary).
 *
 * Selection logic (in workers/tools.ts):
 *   - brave_api_key set → Brave Search
 *   - searxng_url set  → SearXNG
 *   - neither          → web search disabled
 */

import https from "node:https";
import http from "node:http";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";

interface SearxngResult {
  title: string;
  url: string;
  content: string;
  engine: string;
  score: number;
  publishedDate?: string;
}

interface SearxngResponse {
  query: string;
  results: SearxngResult[];
  number_of_results: number;
  suggestions: string[];
}

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

// Why the raw Node http/https module instead of axios or fetch?
// Self-hosted SearXNG instances often use self-signed TLS certificates. The
// native fetch() API and axios do not expose `rejectUnauthorized` in a way
// that is easy to toggle per-request without global side-effects. The raw
// http/https module accepts a per-request `rejectUnauthorized: false` option,
// making it straightforward to support internal SearXNG instances without
// disabling TLS verification globally.
function fetchJson(url: string, timeoutMs: number): Promise<SearxngResponse> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    const req = protocol.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as SearxngResponse);
        } catch (err) {
          reject(new Error(`Failed to parse SearXNG response: ${(err as Error).message}`));
        }
      });
    });

    req.on("error", (err: Error) => {
      reject(new Error(`SearXNG request failed: ${err.message}`));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("SearXNG request timed out"));
    });
  });
}

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

/**
 * Create the web search tool backed by SearXNG.
 */
export function createWebSearchTool(searxngUrl: string): AgentTool<typeof webSearchSchema> {
  return {
    name: "web_search",
    label: "web_search",
    description:
      "Search the web. Returns titles, URLs, and snippets. " +
      "Aggregates results from Google, Bing, DuckDuckGo, Brave, and more.",
    parameters: webSearchSchema,
    async execute(
      _toolCallId: string,
      { query, count, freshness, language }: WebSearchInput,
    ): Promise<AgentToolResult<unknown>> {
      const limit = Math.min(count ?? 10, 20);
      const lang = language ?? "en";

      const params = new URLSearchParams({
        q: query,
        format: "json",
        language: lang,
        safesearch: "0",
      });

      if (freshness) {
        // Normalize common formats
        const timeMap: Record<string, string> = {
          pd: "day",
          pw: "week",
          pm: "month",
          py: "year",
          day: "day",
          week: "week",
          month: "month",
          year: "year",
        };
        const timeRange = timeMap[freshness] ?? freshness;
        params.append("time_range", timeRange);
      }

      const url = `${searxngUrl}/search?${params.toString()}`;

      try {
        const response = await fetchJson(url, 10000);

        const results = (response.results ?? []).slice(0, limit).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: (r.content ?? "").slice(0, 300),
          engine: r.engine ?? "unknown",
        }));

        const text = JSON.stringify({ results }, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { query, results, total: response.number_of_results ?? 0 },
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
