/**
 * Core memory append/replace tools.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type { CoreMemory } from "../memory/core-memory.js";

const coreMemoryAppendSchema = Type.Object({
  section: Type.String({ description: "Section heading to append under" }),
  content: Type.String({ description: "Content to append to the section" }),
});

type CoreMemoryAppendInput = Static<typeof coreMemoryAppendSchema>;

const coreMemoryReplaceSchema = Type.Object({
  section: Type.String({ description: "Section heading to update" }),
  old_text: Type.String({ description: "Existing text to replace" }),
  new_text: Type.String({ description: "New text to insert" }),
});

type CoreMemoryReplaceInput = Static<typeof coreMemoryReplaceSchema>;

export function createCoreMemoryTools(coreMemory: CoreMemory): AgentTool<any>[] {
  const coreMemoryAppendTool: AgentTool<typeof coreMemoryAppendSchema> = {
    name: "memory_core_append",
    label: "memory_core_append",
    description:
      "Add information to your core memory under a section. Core memory is always visible to you. Use for important facts about the user, preferences, and ongoing context. Sections: 'About the User', 'Preferences', 'Current Projects', or create your own.",
    parameters: coreMemoryAppendSchema,
    async execute(
      _toolCallId: string,
      { section, content }: CoreMemoryAppendInput,
    ): Promise<AgentToolResult<unknown>> {
      const result = coreMemory.append(section, content);

      if (!result.ok) {
        const text = JSON.stringify({ error: result.error });
        return {
          content: [{ type: "text", text }],
          details: { error: result.error },
        };
      }

      const text = JSON.stringify({ success: true }, null, 2);
      return {
        content: [{ type: "text", text }],
        details: { success: true },
      };
    },
  };

  const coreMemoryReplaceTool: AgentTool<typeof coreMemoryReplaceSchema> = {
    name: "memory_core_replace",
    label: "memory_core_replace",
    description:
      "Update information in your core memory by replacing specific text within a section. Use when facts change or need correction.",
    parameters: coreMemoryReplaceSchema,
    async execute(
      _toolCallId: string,
      { section, old_text, new_text }: CoreMemoryReplaceInput,
    ): Promise<AgentToolResult<unknown>> {
      const result = coreMemory.replace(section, old_text, new_text);

      if (!result.ok) {
        const text = JSON.stringify({ error: result.error });
        return {
          content: [{ type: "text", text }],
          details: { error: result.error },
        };
      }

      const text = JSON.stringify({ success: true }, null, 2);
      return {
        content: [{ type: "text", text }],
        details: { success: true },
      };
    },
  };

  return [coreMemoryAppendTool, coreMemoryReplaceTool];
}
