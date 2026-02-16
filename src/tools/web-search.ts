/**
 * Web search tool using Brave Search API.
 *
 * Free tier: 2000 queries/month. Paid: $3/1000 queries.
 */

import axios from "axios";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";

const webSearchSchema = Type.Object({
  query: Type.String({ description: "The search query" }),
});

type WebSearchInput = Static<typeof webSearchSchema>;

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web_results: BraveSearchResult[];
}

/**
 * Create the web search tool.
 */
export function createWebSearchTool(apiKey: string): AgentTool<typeof webSearchSchema> {
  return {
    name: "web_search",
    label: "web_search",
    description: "Search the web for information. Returns top results with titles, URLs, and snippets.",
    parameters: webSearchSchema,
    async execute(
      _toolCallId: string,
      { query }: WebSearchInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const response = await axios.get<BraveSearchResponse>(
          "https://api.search.brave.com/res/v1/web/search",
          {
            headers: {
              Accept: "application/json",
              "X-Subscription-Token": apiKey,
            },
            params: {
              q: query,
              count: 5,
            },
            timeout: 10000,
          },
        );

        const results = response.data.web_results?.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description,
        })) || [];

        const text = JSON.stringify({ results }, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { results },
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
