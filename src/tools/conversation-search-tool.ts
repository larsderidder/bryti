/**
 * Conversation search tool.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { searchConversations } from "../memory/conversation-search.js";
import { toolError, toolSuccess } from "./result.js";

const conversationSearchSchema = Type.Object({
  query: Type.String({ description: "Search query for conversation history" }),
});

type ConversationSearchInput = Static<typeof conversationSearchSchema>;

export function createConversationSearchTool(historyDir: string): AgentTool<any> {
  const conversationSearchTool: AgentTool<typeof conversationSearchSchema> = {
    name: "conversation_search",
    label: "conversation_search",
    description:
      "Search your past conversations for messages matching a query. Returns relevant messages with timestamps.",
    parameters: conversationSearchSchema,
    async execute(
      _toolCallId: string,
      { query }: ConversationSearchInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const results = searchConversations(historyDir, query, 10);
        return toolSuccess({ results });
      } catch (error) {
        return toolError(error);
      }
    },
  };

  return conversationSearchTool;
}
