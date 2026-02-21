/**
 * Document tools — HedgeDoc backend.
 *
 * Registers three tools: document_create, document_update, document_read.
 *
 * These tools are the stable interface for collaborative note editing.
 * The tool NAMES are what the agent and users refer to. If you replace
 * this backend (Notion, Google Docs, plain files, anything), keep the
 * same tool names so the agent's behaviour and memory stay consistent.
 *
 * To replace this backend:
 *   1. Rewrite this file (or write a new one and delete this)
 *   2. Implement the same three tools against your preferred API
 *   3. The agent will pick up the new tools on next restart
 *
 * Requirements for HedgeDoc:
 *   - HEDGEDOC_URL env var: internal URL pibot uses (e.g. http://hedgedoc:3000)
 *   - HEDGEDOC_PUBLIC_URL env var: user-facing URL for shared links (optional, defaults to HEDGEDOC_URL)
 *   - HedgeDoc must be started with CMD_ALLOW_FREEURL=true for document_update to work
 *   - See docker-compose.yml for the service definition
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  const baseUrl = (process.env.HEDGEDOC_URL ?? "").replace(/\/$/, "");
  const publicUrl = (process.env.HEDGEDOC_PUBLIC_URL ?? baseUrl).replace(/\/$/, "");

  if (!baseUrl) {
    // HedgeDoc not configured — tools are not registered.
    // Set HEDGEDOC_URL in .env to activate document_create/update/read.
    console.log("[documents-hedgedoc] HEDGEDOC_URL not set — document tools not registered");
    return;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function extractNoteId(location: string): string {
    const parts = location.split("/");
    return parts[parts.length - 1];
  }

  function buildMarkdown(title: string, content: string): string {
    const trimmed = content.trimStart();
    if (trimmed.startsWith("# ")) return trimmed;
    return `# ${title}\n\n${trimmed}`;
  }

  async function hedgedocPost(path: string, body: string): Promise<Response> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body,
      redirect: "manual", // capture 302 Location header ourselves
    });
    if (!response.ok && response.status !== 302) {
      throw new Error(`HedgeDoc returned ${response.status} for ${path}`);
    }
    return response;
  }

  // ---------------------------------------------------------------------------
  // document_create
  // ---------------------------------------------------------------------------

  pi.registerTool({
    name: "document_create",
    label: "document_create",
    description:
      "Create a new collaborative document and return a shareable link. " +
      "Use this whenever the conversation produces content the user should be able to view, " +
      "edit, or share: drafts, plans, research notes, code documents, etc. " +
      "Send the returned url to the user so they can open it in their browser.",
    parameters: Type.Object({
      title: Type.String({ description: "Title for the document (written as the first H1 heading)" }),
      content: Type.String({ description: "Initial markdown content of the document" }),
    }),
    async execute(_toolCallId, { title, content }) {
      try {
        const response = await hedgedocPost("/new", buildMarkdown(title, content));
        const location = response.headers.get("location") ?? "";

        if (!location) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "HedgeDoc did not return a note location" }) }] };
        }

        const noteId = extractNoteId(location);
        const url = `${publicUrl}/${noteId}`;

        return { content: [{ type: "text", text: JSON.stringify({ note_id: noteId, url, title }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to create document: ${error instanceof Error ? error.message : String(error)}` }) }] };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // document_update
  //
  // Uses POST /new/<alias> which overwrites the note when CMD_ALLOW_FREEURL=true.
  // ---------------------------------------------------------------------------

  pi.registerTool({
    name: "document_update",
    label: "document_update",
    description:
      "Replace the full content of an existing document. " +
      "Provide the complete new markdown — this is a full overwrite, not a patch. " +
      "Read the document first with document_read if you need to preserve existing content.",
    parameters: Type.Object({
      note_id: Type.String({ description: "Note ID returned by document_create" }),
      content: Type.String({ description: "Full new markdown content (replaces existing content)" }),
    }),
    async execute(_toolCallId, { note_id, content }) {
      try {
        await hedgedocPost(`/new/${note_id}`, content);
        return { content: [{ type: "text", text: JSON.stringify({ note_id, updated: true }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to update document: ${error instanceof Error ? error.message : String(error)}` }) }] };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // document_read
  // ---------------------------------------------------------------------------

  pi.registerTool({
    name: "document_read",
    label: "document_read",
    description:
      "Read the current markdown content of a document. " +
      "Use this before updating so you can preserve content the user may have edited.",
    parameters: Type.Object({
      note_id: Type.String({ description: "Note ID returned by document_create" }),
    }),
    async execute(_toolCallId, { note_id }) {
      try {
        const response = await fetch(`${baseUrl}/${note_id}/download`);
        if (!response.ok) {
          throw new Error(`HedgeDoc returned ${response.status}`);
        }
        const content = await response.text();
        return { content: [{ type: "text", text: JSON.stringify({ note_id, content }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to read document: ${error instanceof Error ? error.message : String(error)}` }) }] };
      }
    },
  });
}
