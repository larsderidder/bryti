/**
 * Hybrid search: keyword (FTS5) + vector, fused with Reciprocal Rank Fusion.
 *
 * RRF formula: score(doc) = w_vec * 1/(k + rank_vec) + w_kw * 1/(k + rank_kw)
 * Defaults: 0.7 vector, 0.3 keyword, k = 60.
 *
 * Why RRF instead of a weighted average of raw scores?
 * FTS5 BM25 scores and cosine similarity values live on completely different
 * scales, so adding them directly produces garbage. RRF converts each result
 * list to ranks first, making the fusion scale-invariant: it doesn't matter
 * what units either scorer uses.
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
  /**
   * Fusion smoothing constant k (default: 60).
   * Standard RRF value from the original paper. Lower values amplify the
   * advantage of top-ranked documents; 60 is empirically good across most
   * retrieval tasks and avoids over-rewarding a single strong signal.
   */
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
 * Create a hybrid search function over the given memory store.
 *
 * Returns a closure that accepts a query string. The closure calls `embed` on
 * every invocation to produce a fresh query embedding; embeddings are not
 * cached here. Callers that need caching should wrap `embed` before passing
 * it in.
 *
 * @param store   The memory store to search against (provides keyword + vector).
 * @param embed   Embedding function — called once per query, not cached.
 * @param options Weights, k, and result limit overrides.
 * @returns       An async function `(query) => SearchResult[]` ready for use.
 */
export function createHybridSearch(
  store: MemoryStore,
  embed: (text: string) => Promise<number[] | null>,
  options: HybridSearchOptions = {},
): (query: string) => Promise<SearchResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return async function hybridSearch(query: string): Promise<SearchResult[]> {
    if (!query.trim()) {
      return [];
    }

    // embed() returns null when node-llama-cpp is not installed.
    // In that case we fall back to keyword-only search.
    const queryEmbedding = await embed(query);

    const [keywordResults, vectorResults] = await Promise.all([
      store.searchKeyword(query, opts.limit * 2),
      queryEmbedding
        ? store.searchVector(queryEmbedding, opts.limit * 2)
        : Promise.resolve([]),
    ]);

    // Handle empty results
    if (keywordResults.length === 0 && vectorResults.length === 0) {
      return [];
    }

    // Both searches can return the same document. Merge by id: the first time
    // a document appears its entry is created; the second time its score is
    // accumulated and the matching method is appended to matchedBy.
    const resultsMap = new Map<string, SearchResult>();

    // Process keyword results — applies the RRF term: w_kw * 1/(k + rank_kw)
    for (let i = 0; i < keywordResults.length; i++) {
      const result = keywordResults[i];
      const rank = i + 1; // RRF ranks are 1-based
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

    // Process vector results — applies the RRF term: w_vec * 1/(k + rank_vec)
    for (let i = 0; i < vectorResults.length; i++) {
      const result = vectorResults[i];
      const rank = i + 1; // RRF ranks are 1-based
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


