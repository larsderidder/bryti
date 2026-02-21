/**
 * DocumentBackend — the interface all document adapters must implement.
 *
 * The agent-facing tools (document_create, document_update, document_read)
 * depend only on this interface. Swapping backends never touches tool
 * schemas, descriptions, or any agent-visible behaviour.
 */

export interface CreatedDocument {
  /** Stable identifier used to refer back to the document in subsequent calls. */
  note_id: string;
  /** User-facing URL to open the document in a browser. */
  url: string;
}

export interface DocumentBackend {
  /**
   * Create a new document with the given title and markdown content.
   * Returns a stable note_id and a user-facing URL.
   */
  create(title: string, content: string): Promise<CreatedDocument>;

  /**
   * Replace the full content of an existing document.
   * This is a full overwrite, not a patch.
   */
  update(noteId: string, content: string): Promise<void>;

  /**
   * Return the current raw markdown content of a document.
   */
  read(noteId: string): Promise<string>;
}
