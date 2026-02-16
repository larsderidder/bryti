/**
 * Memory manager with SQLite-backed search.
 *
 * Combines:
 * - File-based memory.md (for system prompt injection)
 * - SQLite store for searchable facts
 * - Automatic migration of existing memory.md
 */

import fs from "node:fs";
import path from "node:path";
import type { MemoryManager } from "../memory.js";
import { createMemoryStore, type MemoryStore } from "./store.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { createHybridSearch, createHybridMemorySearch } from "./search.js";
import { createIndexer } from "./indexer.js";

export interface SearchableMemoryManager extends MemoryManager {
  /** Search memory. */
  search(query: string): Promise<Array<{
    content: string;
    source: string;
    score: number;
  }>>;

  /** Record a fact. */
  recordFact(fact: string): Promise<void>;

  /** Get the underlying store (for testing). */
  readonly store: MemoryStore;
}

/**
 * Create a searchable memory manager with automatic migration.
 */
export async function createSearchableMemoryManager(
  dataDir: string,
  userId: string,
): Promise<SearchableMemoryManager> {
  // Get the memory file path
  const filePath = path.join(dataDir, "memory.md");

  // Ensure directory exists
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // Create the SQLite store
  const store = createMemoryStore(userId, dataDir);

  // Create the embedding provider
  const embeddings = await createEmbeddingProvider({ type: "local" });

  // Create the search function
  const hybridSearch = createHybridMemorySearch(store, embeddings);

  // Create the indexer
  const indexer = createIndexer(store, embeddings);

  // Check if memory.md exists and needs migration
  let needsMigration = false;
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    if (content.trim().length > 0) {
      // Check if already indexed by searching
      const existing = store.searchKeyword(".", 1);
      if (existing.length === 0) {
        needsMigration = true;
      }
    }
  }

  // Run migration if needed
  if (needsMigration) {
    console.log(`[Memory] Migrating existing memory.md for user ${userId}`);
    const content = fs.readFileSync(filePath, "utf-8");
    await indexer.indexMemoryFile(content);
  }

  return {
    filePath,

    async read(): Promise<string> {
      if (!fs.existsSync(filePath)) {
        return "";
      }
      return fs.readFileSync(filePath, "utf-8");
    },

    async update(content: string): Promise<void> {
      fs.writeFileSync(filePath, content, "utf-8");
    },

    async search(query: string): Promise<Array<{ content: string; source: string; score: number }>> {
      const results = await hybridSearch.search(query);
      return results.map((r) => ({
        content: r.content,
        source: r.source,
        score: r.combinedScore,
      }));
    },

    async recordFact(fact: string): Promise<void> {
      const embedding = await embeddings.embed(fact);
      store.addFact(fact, "recorded", embedding);
    },

    store,
  };
}

/**
 * Check if a user's memory needs migration.
 */
export function needsMigration(dataDir: string, userId: string): boolean {
  const filePath = path.join(dataDir, "users", userId, "memory.db");
  
  // If no database exists, migration will happen on first run
  if (!fs.existsSync(filePath)) {
    return true;
  }

  // Check if memory.md has content but database doesn't have facts
  const memoryPath = path.join(dataDir, "memory.md");
  if (!fs.existsSync(memoryPath)) {
    return false;
  }

  const content = fs.readFileSync(memoryPath, "utf-8");
  if (content.trim().length === 0) {
    return false;
  }

  // For now, we assume if the DB exists, it's already migrated
  // A more thorough check would query the DB
  return false;
}
