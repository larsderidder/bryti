/**
 * Document tools — stable interface for collaborative note editing.
 *
 * The agent calls document_create, document_update, document_read.
 * The backend is HedgeDoc (default). If HedgeDoc is not configured,
 * none of these tools are registered and the agent falls back to chat.
 *
 * Interface contract: tool names and schemas are stable across backends.
 * Swapping HedgeDoc for another adapter (Notion, Google Docs, etc.) must
 * not require changes to prompts, memory, or agent behaviour.
 */

import axios from "axios";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { toolError, toolSuccess } from "./result.js";

// ---------------------------------------------------------------------------
// Schemas
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
// HedgeDoc backend
// ---------------------------------------------------------------------------

/**
 * Extract the note ID from a HedgeDoc redirect URL.
 *
 * HedgeDoc responds to POST /new with a 302 redirect to /<noteId>.
 * Axios follows redirects by default; we configure maxRedirects: 0 so we
 * can read the Location header ourselves.
 */
function extractNoteId(location: string): string {
  // Location is either "/<id>" or "https://host/<id>"
  const parts = location.split("/");
  return parts[parts.length - 1];
}

/**
 * Build the markdown body including title as H1.
 */
function buildMarkdown(title: string, content: string): string {
  const trimmedContent = content.trimStart();
  // Only prepend H1 if the content doesn't already start with one
  if (trimmedContent.startsWith("# ")) {
    return trimmedContent;
  }
  return `# ${title}\n\n${trimmedContent}`;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface HedgeDocConfig {
  /** Internal URL pibot uses to reach HedgeDoc (e.g. http://hedgedoc:3000) */
  url: string;
  /** User-facing URL for sharing links (defaults to url if not set) */
  public_url?: string;
}

/**
 * Create document tools backed by HedgeDoc.
 *
 * Returns an empty array when config is not provided, so callers can
 * unconditionally spread the result into the tools list.
 */
export function createDocumentTools(config: HedgeDocConfig | undefined): AgentTool<any>[] {
  if (!config) return [];

  const baseUrl = config.url.replace(/\/$/, "");
  const publicUrl = (config.public_url ?? config.url).replace(/\/$/, "");

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
      const markdown = buildMarkdown(title, content);

      try {
        // POST /new — HedgeDoc returns 302 to the new note. We capture the
        // Location header before axios follows the redirect.
        const response = await axios.post(`${baseUrl}/new`, markdown, {
          headers: { "Content-Type": "text/markdown" },
          maxRedirects: 0,
          validateStatus: (s) => s === 302 || (s >= 200 && s < 300),
        });

        const location: string =
          response.headers["location"] ??
          response.headers["Location"] ??
          "";

        if (!location) {
          return toolError("HedgeDoc did not return a note location");
        }

        const noteId = extractNoteId(location);
        const url = `${publicUrl}/${noteId}`;

        return toolSuccess({ note_id: noteId, url, title });
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
        // HedgeDoc 1.x has no PATCH/PUT for note content via the public REST API.
        // The workaround is to use the /new/<ALIAS> endpoint: create a new note
        // with the same alias, which overwrites the content when FreeURL mode is on.
        // For broad compatibility we POST to /new/<noteId> and accept either a 200
        // (note updated in place) or a 302 (redirect to note).
        await axios.post(`${baseUrl}/new/${note_id}`, content, {
          headers: { "Content-Type": "text/markdown" },
          maxRedirects: 0,
          validateStatus: (s) => s === 302 || (s >= 200 && s < 300),
        });

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
        const response = await axios.get(`${baseUrl}/${note_id}/download`, {
          responseType: "text",
          validateStatus: (s) => s >= 200 && s < 300,
        });

        const content = typeof response.data === "string" ? response.data : String(response.data);
        return toolSuccess({ note_id, content });
      } catch (error) {
        return toolError(error, "Failed to read document");
      }
    },
  };

  return [createTool, updateTool, readTool];
}
