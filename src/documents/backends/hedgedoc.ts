/**
 * HedgeDoc backend for the document capability.
 *
 * HedgeDoc 1.x API used here:
 *   POST /new                  — create note, returns 302 with Location: /<noteId>
 *   POST /new/<alias>          — overwrite note by alias (requires CMD_ALLOW_FREEURL=true)
 *   GET  /<noteId>/download    — raw markdown content
 *
 * IMPORTANT: document_update relies on CMD_ALLOW_FREEURL=true being set on the
 * HedgeDoc instance. Without it, POST /new/<alias> creates a new note instead
 * of overwriting the existing one. The docker-compose template sets this flag.
 */

import axios from "axios";
import type { DocumentBackend, CreatedDocument } from "../types.js";

export interface HedgeDocConfig {
  /** Internal URL pibot uses to reach HedgeDoc (e.g. http://hedgedoc:3000). */
  url: string;
  /** User-facing URL for links sent to the user. Defaults to url if omitted. */
  public_url?: string;
}

/**
 * Extract the note ID from a HedgeDoc redirect Location header.
 * Location is either "/<id>" or "https://host/<id>".
 */
function extractNoteId(location: string): string {
  const parts = location.split("/");
  return parts[parts.length - 1];
}

/**
 * Build markdown body, ensuring title appears as the first H1.
 * If content already starts with "# " the title is not prepended.
 */
function buildMarkdown(title: string, content: string): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("# ")) return trimmed;
  return `# ${title}\n\n${trimmed}`;
}

export class HedgeDocBackend implements DocumentBackend {
  private readonly baseUrl: string;
  private readonly publicUrl: string;

  constructor(config: HedgeDocConfig) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.publicUrl = (config.public_url ?? config.url).replace(/\/$/, "");
  }

  async create(title: string, content: string): Promise<CreatedDocument> {
    const markdown = buildMarkdown(title, content);

    const response = await axios.post(`${this.baseUrl}/new`, markdown, {
      headers: { "Content-Type": "text/markdown" },
      // Capture the 302 Location header instead of following the redirect.
      maxRedirects: 0,
      validateStatus: (s) => s === 302 || (s >= 200 && s < 300),
    });

    const location: string =
      response.headers["location"] ?? response.headers["Location"] ?? "";

    if (!location) {
      throw new Error("HedgeDoc did not return a note location after create");
    }

    const noteId = extractNoteId(location);
    return { note_id: noteId, url: `${this.publicUrl}/${noteId}` };
  }

  async update(noteId: string, content: string): Promise<void> {
    await axios.post(`${this.baseUrl}/new/${noteId}`, content, {
      headers: { "Content-Type": "text/markdown" },
      maxRedirects: 0,
      validateStatus: (s) => s === 302 || (s >= 200 && s < 300),
    });
  }

  async read(noteId: string): Promise<string> {
    const response = await axios.get(`${this.baseUrl}/${noteId}/download`, {
      responseType: "text",
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return typeof response.data === "string" ? response.data : String(response.data);
  }
}
