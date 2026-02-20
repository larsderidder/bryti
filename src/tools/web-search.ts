/**
 * Web search tool using SearXNG.
 *
 * Self-hosted metasearch at search.xithing.eu. No API key, no rate limits.
 * Aggregates results from Google, Bing, DuckDuckGo, Brave, and more.
 *
 * Workers only — not available to the main agent (security boundary).
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
