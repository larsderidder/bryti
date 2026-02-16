/**
 * Hybrid search combining keyword (FTS5) and vector search using Reciprocal Rank Fusion.
 *
 * Fusion formula:
 * score(doc) = weight_vector * (1 / (k + rank_vector)) + weight_keyword * (1 / (k + rank_keyword))
 *
 * Default weights: 0.7 vector, 0.3 keyword. k = 60.
 */

import type { MemoryStore, ScoredResult } from "./store.js";
import type { EmbeddingProvider } from "./embeddings.js";

export interface SearchResult extends ScoredResult {
  /** Combined score from both methods. */
  combinedScore: number;
  /** Which methods matched (for debugging/display). */
  matchedBy: ("keyword" | "vector")[];
}

export interface HybridSearchOptions {
  /** Weight for vector search results (default: 0.7) */
  vectorWeight?: number;
  /** Weight for keyword search results (default: 0.3) */
  keywordWeight?: number;
  /** Fusion parameter k (default: 60) */
  k?: number;
  /** Maximum results to return (default: 5) */
  limit?: number;
}

const DEFAULT_OPTIONS: Required<HybridSearchOptions> = {
  vectorWeight: 0.7,
  keywordWeight: 0.3,
  k: 60,
  limit: 5,
};

/**
 * Create a hybrid search function.
 */
export function createHybridSearch(
  store: MemoryStore,
  embeddingProvider: EmbeddingProvider,
  options: HybridSearchOptions = {},
): (query: string) => Promise<SearchResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return async function hybridSearch(query: string): Promise<SearchResult[]> {
    // Handle empty query
    if (!query.trim()) {
      return [];
    }

    // Get embedding for query
    const queryEmbedding = await embeddingProvider.embed(query);

    // Run both searches in parallel
    const [keywordResults, vectorResults] = await Promise.all([
      store.searchKeyword(query, opts.limit * 2), // Get more to account for dedup
      store.searchVector(queryEmbedding, opts.limit * 2),
    ]);

    // Handle empty results
    if (keywordResults.length === 0 && vectorResults.length === 0) {
      return [];
    }

    // Create a map of results by ID for efficient lookup
    const resultsMap = new Map<string, SearchResult>();

    // Process keyword results
    for (let i = 0; i < keywordResults.length; i++) {
      const result = keywordResults[i];
      const rank = i + 1;
      const score = opts.keywordWeight * (1 / (opts.k + rank));

      if (resultsMap.has(result.id)) {
        const existing = resultsMap.get(result.id)!;
        existing.combinedScore += score;
        existing.matchedBy.push("keyword");
      } else {
        resultsMap.set(result.id, {
          ...result,
          combinedScore: score,
          matchedBy: ["keyword"],
        });
      }
    }

    // Process vector results
    for (let i = 0; i < vectorResults.length; i++) {
      const result = vectorResults[i];
      const rank = i + 1;
      const score = opts.vectorWeight * (1 / (opts.k + rank));

      if (resultsMap.has(result.id)) {
        const existing = resultsMap.get(result.id)!;
        existing.combinedScore += score;
        existing.matchedBy.push("vector");
      } else {
        resultsMap.set(result.id, {
          ...result,
          combinedScore: score,
          matchedBy: ["vector"],
        });
      }
    }

    // Convert to array and sort by combined score
    const mergedResults = Array.from(resultsMap.values())
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, opts.limit);

    return mergedResults;
  };
}

/**
 * Create a hybrid search with a simpler interface for use in tools.
 */
export interface HybridMemorySearch {
  /** Search memory for relevant facts. */
  search(query: string): Promise<SearchResult[]>;
}

export function createHybridMemorySearch(
  store: MemoryStore,
  embeddingProvider: EmbeddingProvider,
): HybridMemorySearch {
  const search = createHybridSearch(store, embeddingProvider);

  return {
    async search(query: string): Promise<SearchResult[]> {
      return search(query);
    },
  };
}
