/**
 * Archival memory tools.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { createHybridSearch } from "../memory/search.js";
import type { MemoryStore } from "../memory/store.js";
import type { ProjectionStore } from "../projection/store.js";
import { toolError, toolSuccess } from "./result.js";

const archivalMemoryInsertSchema = Type.Object({
  content: Type.String({ description: "Content to store in archival memory" }),
});

type ArchivalMemoryInsertInput = Static<typeof archivalMemoryInsertSchema>;

const archivalMemorySearchSchema = Type.Object({
  query: Type.String({ description: "Search query for archival memory" }),
});

type ArchivalMemorySearchInput = Static<typeof archivalMemorySearchSchema>;

export function createArchivalMemoryTools(
  store: MemoryStore,
  embed: (text: string) => Promise<number[] | null>,
  projectionStore?: ProjectionStore,
): AgentTool<any>[] {
  const hybridSearch = createHybridSearch(store, embed);

  const insertTool: AgentTool<typeof archivalMemoryInsertSchema> = {
    name: "memory_archival_insert",
    label: "memory_archival_insert",
    description:
      "Store a fact in long-term archival memory. Use for detailed information that does not need to be in core memory.",
    parameters: archivalMemoryInsertSchema,
    async execute(
      _toolCallId: string,
      { content }: ArchivalMemoryInsertInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        // Embed at write time, not at search time. Inserts are infrequent (one
        // per deliberate memory operation); searches happen on every user query.
        // Paying the embedding cost up front keeps search latency predictable.
        const embedding = await embed(content);
        store.addFact(content, "archival", embedding);

        // This is what makes "remind me when X happens" commitments work.
        // Any projection created with a trigger_on_fact condition sits in a
        // 'pending' state until an archival insert mentions matching content.
        // checkTriggers() does keyword matching first, then cosine similarity
        // as a fallback, and marks matched projections as 'triggered'.
        const triggered = projectionStore ? await projectionStore.checkTriggers(content, embed) : [];

        if (triggered.length > 0) {
          const summaries = triggered.map((p) => p.summary);
          return toolSuccess({ success: true, triggered: summaries });
        }

        return toolSuccess({ success: true });
      } catch (error) {
        return toolError(error);
      }
    },
  };

  const searchTool: AgentTool<typeof archivalMemorySearchSchema> = {
    name: "memory_archival_search",
    label: "memory_archival_search",
    description:
      "Search your long-term archival memory for relevant facts. Use when you need detailed information not in core memory.",
    parameters: archivalMemorySearchSchema,
    async execute(
      _toolCallId: string,
      { query }: ArchivalMemorySearchInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const results = await hybridSearch(query);
        const formatted = results.map((result) => ({
          id: result.id,
          content: result.content,
          source: result.source,
          score: result.combinedScore,
          matchedBy: result.matchedBy,
        }));
        return toolSuccess({ results: formatted });
      } catch (error) {
        return toolError(error);
      }
    },
  };

  return [insertTool, searchTool];
}
