/**
 * Memory indexer for chunking and indexing content.
 *
 * Handles:
 * - Chunking memory.md content on markdown headers
 * - Chunking conversation messages
 * - Hash-based change detection to avoid re-indexing unchanged content
 * - Embedding generation for indexed content
 */

import crypto from "node:crypto";
import type { MemoryStore } from "./store.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { ChatMessage } from "../history.js";

export interface IndexedChunk {
  content: string;
  hash: string;
  source: string;
}

/**
 * Chunk text into smaller pieces.
 *
 * For markdown: splits on headers (#, ##, ###)
 * For plain text: splits on paragraph boundaries
 * Max ~512 tokens per chunk.
 */
export function chunkText(text: string, maxTokens: number = 512): string[] {
  // For markdown content, try to split on headers
  const lines = text.split("\n");
  const chunks: string[] = [];
  let currentChunk: string[] = [];

  for (const line of lines) {
    // Check if this is a markdown header
    const isHeader = /^#{1,6}\s+/.test(line);

    if (isHeader && currentChunk.length > 0) {
      // Start a new chunk with the header
      chunks.push(currentChunk.join("\n").trim());
      currentChunk = [line];
    } else {
      currentChunk.push(line);
    }
  }

  // Add the last chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join("\n").trim());
  }

  // If we only got one chunk but it's long, try to split on paragraph boundaries
  if (chunks.length === 1 && chunks[0].length > maxTokens * 4) {
    return chunkByParagraph(chunks[0], maxTokens);
  }

  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Chunk text by paragraph boundaries.
 */
function chunkByParagraph(text: string, maxTokens: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    if (currentChunk.length + para.length > maxTokens * 4) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + para;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Compute SHA256 hash of content.
 */
export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Create a memory indexer.
 */
export function createIndexer(
  store: MemoryStore,
  embeddingProvider: EmbeddingProvider,
): {
  indexMemoryFile: (content: string) => Promise<void>;
  indexConversation: (messages: ChatMessage[]) => Promise<void>;
  reindexAll: () => Promise<void>;
} {
  // Track indexed hashes per source
  const indexedHashes = new Map<string, Set<string>>();

  return {
    /**
     * Index memory.md content.
     * Only indexes content that has changed (hash check).
     */
    async indexMemoryFile(content: string): Promise<void> {
      if (!content.trim()) {
        return;
      }

      const chunks = chunkText(content);
      const source = "memory.md";

      // Get existing hashes for this source
      if (!indexedHashes.has(source)) {
        indexedHashes.set(source, new Set());
      }
      const existingHashes = indexedHashes.get(source)!;

      for (const chunk of chunks) {
        const hash = computeHash(chunk);

        // Skip if already indexed
        if (existingHashes.has(hash)) {
          continue;
        }

        // Generate embedding and store
        const embedding = await embeddingProvider.embed(chunk);
        store.addFact(chunk, source, embedding);

        // Track the hash
        existingHashes.add(hash);
      }
    },

    /**
     * Index conversation messages.
     */
    async indexConversation(messages: ChatMessage[]): Promise<void> {
      const source = "conversation";

      // Get existing hashes for this source
      if (!indexedHashes.has(source)) {
        indexedHashes.set(source, new Set());
      }
      const existingHashes = indexedHashes.get(source)!;

      for (const msg of messages) {
        // Skip system messages
        if (msg.role === "system") {
          continue;
        }

        const content = msg.content;
        if (!content.trim()) {
          continue;
        }

        const hash = computeHash(content + msg.role);

        // Skip if already indexed
        if (existingHashes.has(hash)) {
          continue;
        }

        // Generate embedding and store
        const embedding = await embeddingProvider.embed(content);
        store.addFact(content, source, embedding);

        // Track the hash
        existingHashes.add(hash);
      }
    },

    /**
     * Re-index all content (clear existing and re-index).
     */
    async reindexAll(): Promise<void> {
      // Clear all indexed hashes
      indexedHashes.clear();
      // Note: In a full implementation, we'd also clear and re-index the store
      // For now, this is a placeholder
    },
  };
}
