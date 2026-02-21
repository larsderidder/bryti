/**
 * Document tools — stable agent interface for collaborative note editing.
 *
 * This file knows nothing about HedgeDoc, Notion, Google Docs, or any
 * other backend. It depends only on DocumentBackend from types.ts.
 *
 * Tool names and parameter schemas are the stable contract. Agent prompts,
 * memory, and behaviour reference only these names.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { toolError, toolSuccess } from "../tools/result.js";
import type { DocumentBackend } from "./types.js";

// ---------------------------------------------------------------------------
// Schemas (stable — do not change names or shapes without a migration plan)
// ---------------------------------------------------------------------------

const createSchema = Type.Object({
  title: Type.String({ description: "Title for the document (written as the first H1 heading)" }),
  content: Type.String({ description: "Initial markdown content of the document" }),
});

const updateSchema = Type.Object({
  note_id: Type.String({ description: "Note ID returned by document_create" }),
  content: Type.String({ description: "Full new markdown content (replaces existing content)" }),
});

const readSchema = Type.Object({
  note_id: Type.String({ description: "Note ID returned by document_create" }),
});

type CreateInput = Static<typeof createSchema>;
type UpdateInput = Static<typeof updateSchema>;
type ReadInput = Static<typeof readSchema>;

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the three document tools wired to the given backend.
 *
 * Pass the result to the tool registry. To disable document tools entirely,
 * simply don't call this function — no tools, no registration, no errors.
 */
export function createDocumentTools(backend: DocumentBackend): AgentTool<any>[] {
  const createTool: AgentTool<typeof createSchema> = {
    name: "document_create",
    label: "document_create",
    description:
      "Create a new collaborative document and return a shareable link. " +
      "Use this whenever the conversation produces content the user should be able to view, " +
      "edit, or share: drafts, plans, research notes, code documents, etc. " +
      "Send the returned url to the user so they can open it in their browser.",
    parameters: createSchema,
    async execute(
      _toolCallId: string,
      { title, content }: CreateInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const doc = await backend.create(title, content);
        return toolSuccess({ note_id: doc.note_id, url: doc.url, title });
      } catch (error) {
        return toolError(error, "Failed to create document");
      }
    },
  };

  const updateTool: AgentTool<typeof updateSchema> = {
    name: "document_update",
    label: "document_update",
    description:
      "Replace the full content of an existing document. " +
      "Provide the complete new markdown — this is a full overwrite, not a patch. " +
      "Read the document first with document_read if you need to preserve existing content.",
    parameters: updateSchema,
    async execute(
      _toolCallId: string,
      { note_id, content }: UpdateInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        await backend.update(note_id, content);
        return toolSuccess({ note_id, updated: true });
      } catch (error) {
        return toolError(error, "Failed to update document");
      }
    },
  };

  const readTool: AgentTool<typeof readSchema> = {
    name: "document_read",
    label: "document_read",
    description:
      "Read the current markdown content of a document. " +
      "Use this before updating so you can preserve content the user may have edited.",
    parameters: readSchema,
    async execute(
      _toolCallId: string,
      { note_id }: ReadInput,
    ): Promise<AgentToolResult<unknown>> {
      try {
        const content = await backend.read(note_id);
        return toolSuccess({ note_id, content });
      } catch (error) {
        return toolError(error, "Failed to read document");
      }
    },
  };

  return [createTool, updateTool, readTool];
}
