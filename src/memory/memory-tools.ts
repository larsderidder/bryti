/**
 * Memory tools for the agent.
 *
 * Adds search_memory and record_fact tools alongside existing read_memory/update_memory.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { HybridMemorySearch } from "./search.js";
import type { MemoryStore } from "./store.js";

// Schema for search_memory
const searchMemorySchema = Type.Object({
  query: Type.String({ description: "Search query to find relevant memories" }),
});

type SearchMemoryInput = Static<typeof searchMemorySchema>;

// Schema for record_fact
const recordFactSchema = Type.Object({
  fact: Type.String({ description: "A fact to remember about the user or conversation" }),
});

type RecordFactInput = Static<typeof recordFactSchema>;

/**
 * Create memory tools (search_memory and record_fact).
 */
export function createMemorySearchTools(
  search: HybridMemorySearch,
  store: MemoryStore,
  embed: (text: string) => Promise<number[]>,
): AgentTool<any>[] {

  const searchMemoryTool: AgentTool<typeof searchMemorySchema> = {
    name: "search_memory",
    label: "search_memory",
    description:
      "Search through past memories and conversations. Use this to find information the user has previously shared or that was discussed.",
    parameters: searchMemorySchema,
    async execute(
      _toolCallId: string,
      { query }: SearchMemoryInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const results = await search.search(query);

        if (results.length === 0) {
          const text = JSON.stringify({ results: [], message: "No matching memories found" });
          return {
            content: [{ type: "text", text }],
            details: { results: [], message: "No matching memories found" },
          };
        }

        const formattedResults = results.map((r) => ({
          snippet: r.content.slice(0, 200) + (r.content.length > 200 ? "..." : ""),
          score: r.combinedScore,
          source: r.source,
          matchedBy: r.matchedBy,
        }));

        const text = JSON.stringify({ results: formattedResults }, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { results: formattedResults },
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

  const recordFactTool: AgentTool<typeof recordFactSchema> = {
    name: "record_fact",
    label: "record_fact",
    description:
      "Record a specific fact to remember. Use this to save important information about the user without modifying the full memory file.",
    parameters: recordFactSchema,
    async execute(
      _toolCallId: string,
      { fact }: RecordFactInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        // Generate embedding and store the fact
        const embedding = await embed(fact);
        store.addFact(fact, "recorded", embedding);

        const text = JSON.stringify({ success: true, message: "Fact recorded" });
        return {
          content: [{ type: "text", text }],
          details: { success: true },
        };
      } catch (error) {
        const err = error as Error;
        const text = JSON.stringify({ error: `Failed to record fact: ${err.message}` });
        return {
          content: [{ type: "text", text }],
          details: { error: err.message },
        };
      }
    },
  };

  return [searchMemoryTool, recordFactTool];
}
