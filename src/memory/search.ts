/**
 * Hybrid search: keyword (FTS5) + vector, fused with Reciprocal Rank Fusion.
 *
 * RRF formula: score(doc) = w_vec * 1/(k + rank_vec) + w_kw * 1/(k + rank_kw)
 * Defaults: 0.7 vector, 0.3 keyword, k = 60.
 */

import type { MemoryStore, ScoredResult } from "./store.js";

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
  embed: (text: string) => Promise<number[]>,
  options: HybridSearchOptions = {},
): (query: string) => Promise<SearchResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return async function hybridSearch(query: string): Promise<SearchResult[]> {
    // Handle empty query
    if (!query.trim()) {
      return [];
    }

    // Get embedding for query
    const queryEmbedding = await embed(query);

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


