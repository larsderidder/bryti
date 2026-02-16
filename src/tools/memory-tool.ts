/**
 * Memory read/update tools.
 *
 * Thin wrappers around MemoryManager, exposed as pi ToolDefinitions
 * so the agent can read and update persistent memory.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { MemoryManager } from "../memory.js";

// Schema for read_memory (no params)
const readMemorySchema = Type.Object({});

type ReadMemoryInput = Static<typeof readMemorySchema>;

// Schema for update_memory
const updateMemorySchema = Type.Object({
  content: Type.String({ description: "The new full content for memory. Include all existing information plus any new updates." }),
});

type UpdateMemoryInput = Static<typeof updateMemorySchema>;

/**
 * Create memory tools.
 */
export function createMemoryTools(memoryManager: MemoryManager): AgentTool<any>[] {
  const readMemoryTool: AgentTool<typeof readMemorySchema> = {
    name: "read_memory",
    label: "read_memory",
    description:
      "Read the persistent memory content. This contains important information about the user that should be remembered across conversations.",
    parameters: readMemorySchema,
    async execute(): Promise<AgentToolResult<unknown>> {
      const content = await memoryManager.read();
      const text = JSON.stringify({ content }, null, 2);
      return {
        content: [{ type: "text", text }],
        details: { content },
      };
    },
  };

  const updateMemoryTool: AgentTool<typeof updateMemorySchema> = {
    name: "update_memory",
    label: "update_memory",
    description:
      "Update the persistent memory. Use this to save important facts about the user, their preferences, and anything they ask you to remember. When updating, preserve existing content and add/modify as needed.",
    parameters: updateMemorySchema,
    async execute(
      _toolCallId: string,
      { content }: UpdateMemoryInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        await memoryManager.update(content);
        const text = JSON.stringify({ success: true }, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { success: true },
        };
      } catch (error) {
        const err = error as Error;
        const text = JSON.stringify({ error: `Failed to update memory: ${err.message}` });
        return {
          content: [{ type: "text", text }],
          details: { error: err.message },
        };
      }
    },
  };

  return [readMemoryTool, updateMemoryTool];
}
