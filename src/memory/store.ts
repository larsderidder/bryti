/**
 * Per-user memory store backed by SQLite with FTS5 for keyword search and
 * binary Float32Array blobs for embeddings. Vector search uses the sqlite-vec
 * extension (vec0 virtual table with cosine distance) when available, falling
 * back to an in-memory full table scan for compatibility.
 *
 * Embedding dimensions: 2048 (embeddinggemma-300M-Q8_0 output size).
 * vec0 uses cosine distance, matching the previous cosine similarity ranking.
 * Distance 0 = identical; distance 2 = opposite. Results are re-expressed as
 * similarity scores (1 - distance / 2) so callers see the same 0..1 range as
 * before.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { cosineSimilarity } from "../util/math.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface ScoredResult {
  id: string;
  content: string;
  source: string;
  timestamp: number;
  score: number;
}

export interface MemoryStore {
  /** Add a fact to the store. Returns the fact ID. Embedding is optional;
   *  when null, the fact is stored without a vector (keyword search only). */
  addFact(content: string, source: string, embedding: number[] | null): string;

  /** Remove a fact by ID. */
  removeFact(id: string): void;

  /** Search using keyword (FTS5). */
  searchKeyword(query: string, limit: number): ScoredResult[];

  /** Search using vector similarity. Uses the vec0 ANN index when available,
   *  falls back to an in-memory cosine similarity scan otherwise. */
  searchVector(embedding: number[], limit: number): ScoredResult[];

  /** Close the database connection. */
  close(): void;
}

/**
 * Embedding dimension produced by embeddinggemma-300M.
 * Must match the vec0 table definition — change both together.
 */
const EMBEDDING_DIM = 2048;

/**
 * Serialize an embedding vector to a raw binary buffer.
 * Stored as Float32Array bytes (4 bytes per dimension) rather than JSON,
 * which avoids the significant parse/stringify overhead for ~2048-dim vectors
 * and halves the storage footprint compared to text representation.
 */
function serializeEmbedding(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

/**
 * Deserialize a raw binary buffer back to a number array.
 * Inverse of serializeEmbedding: reads raw Float32 bytes from the blob column.
 */
function deserializeEmbedding(buffer: Buffer): number[] {
  const array = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  return Array.from(array);
}

/**
 * Create a per-user memory store.
 *
 * @param userId User ID for isolation
 * @param dataDir Base data directory
 */
export function createMemoryStore(userId: string, dataDir: string): MemoryStore {
  // Schema overview:
  //   facts               — main table; one row per stored fact
  //                         (id TEXT PK, content, source, timestamp, hash)
  //   facts_fts           — FTS5 virtual table shadowing facts.content for
  //                         BM25 keyword search
  //   fact_embeddings     — binary blob table keyed by the same TEXT id as
  //                         facts; used as fallback when sqlite-vec is absent
  //   fact_embeddings_vec — vec0 virtual table for ANN (approximate nearest
  //                         neighbour) search; keyed by facts.rowid (integer)
  //
  // Three triggers (facts_ai, facts_ad, facts_au) keep facts_fts in sync with
  // facts automatically on insert, delete, and update.
  const userDir = path.join(dataDir, "users", userId);
  fs.mkdirSync(userDir, { recursive: true });

  const dbPath = path.join(userDir, "memory.db");
  const db = new Database(dbPath);

  // Load the sqlite-vec extension. This is a no-op if the shared library is
  // missing; we catch the error and fall back to the full-scan path.
  let vecAvailable = false;
  try {
    sqliteVec.load(db);
    vecAvailable = true;
  } catch (err) {
    console.warn("[memory] sqlite-vec not available, using full-scan vector search:", err);
  }

  // Enable WAL mode for concurrent reads
  db.pragma("journal_mode = WAL");

  // Create tables
  db.exec(`
    -- Main facts table
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      hash TEXT NOT NULL
    );

    -- Unique index on hash so duplicate content is detected in O(log n).
    -- Added after the table creation so existing DBs gain it automatically.
    CREATE UNIQUE INDEX IF NOT EXISTS facts_hash_unique ON facts(hash);

    -- FTS5 virtual table for keyword search
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      content,
      content='facts',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;

    CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
    END;

    CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, content) VALUES('delete', OLD.rowid, OLD.content);
      INSERT INTO facts_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;

    -- Blob table to store embeddings (binary Float32Array).
    -- Retained as the data source for backfill and as a fallback when
    -- sqlite-vec is not available.
    CREATE TABLE IF NOT EXISTS fact_embeddings (
      id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (id) REFERENCES facts(id) ON DELETE CASCADE
    );
  `);

  // Create the vec0 ANN index when sqlite-vec loaded successfully.
  // Uses cosine distance to match the previous ranking behaviour.
  // Keyed by facts.rowid (integer) so we can join back to facts without
  // a separate id-to-rowid lookup table.
  if (vecAvailable) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fact_embeddings_vec
      USING vec0(embedding float[${EMBEDDING_DIM}] distance_metric=cosine);
    `);

    // One-time backfill: populate vec0 from any embeddings already stored in
    // fact_embeddings that are not yet in the ANN index. This runs on every
    // startup but is a no-op once all rows are indexed.
    const unindexed = db.prepare(`
      SELECT f.rowid AS rowid, fe.embedding
      FROM fact_embeddings fe
      JOIN facts f ON f.id = fe.id
      WHERE NOT EXISTS (
        SELECT 1 FROM fact_embeddings_vec v WHERE v.rowid = f.rowid
      )
    `).all() as Array<{ rowid: number; embedding: Buffer }>;

    if (unindexed.length > 0) {
      const insVec = db.prepare(
        "INSERT INTO fact_embeddings_vec(rowid, embedding) VALUES (?, ?)",
      );
      const backfill = db.transaction(() => {
        for (const row of unindexed) {
          insVec.run(BigInt(row.rowid), row.embedding);
        }
      });
      backfill();
      console.log(`[memory] Backfilled ${unindexed.length} embedding(s) into vec0 index for user ${userId}`);
    }
  }

  // Prepared statements for efficiency

  // Duplicate detection: look up an existing fact by content hash.
  // Returns the existing id when the same content was already stored.
  const selectByHash = db.prepare<[string], { id: string }>(
    "SELECT id FROM facts WHERE hash = ?",
  );

  const insertFact = db.prepare(`
    INSERT INTO facts (id, content, source, timestamp, hash)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertEmbedding = db.prepare(`
    INSERT INTO fact_embeddings (id, embedding) VALUES (?, ?)
  `);

  const insertEmbeddingVec = vecAvailable
    ? db.prepare("INSERT INTO fact_embeddings_vec(rowid, embedding) VALUES (?, ?)")
    : null;

  const deleteFact = db.prepare(`
    DELETE FROM facts WHERE id = ?
  `);

  const deleteEmbedding = db.prepare(`
    DELETE FROM fact_embeddings WHERE id = ?
  `);

  // Look up the integer rowid for a fact UUID. Used when deleting from vec0.
  const selectRowid = db.prepare<[string], { rowid: number }>(
    "SELECT rowid FROM facts WHERE id = ?",
  );

  const deleteEmbeddingVec = vecAvailable
    ? db.prepare("DELETE FROM fact_embeddings_vec WHERE rowid = ?")
    : null;

  // Full-scan fallback: load all embeddings from fact_embeddings into memory.
  const selectEmbeddings = db.prepare(`
    SELECT f.id, f.content, f.source, f.timestamp, fe.embedding
    FROM facts f
    JOIN fact_embeddings fe ON f.id = fe.id
  `);

  return {
    /**
     * Add a fact to the store and return its ID.
     *
     * @param content  The fact text to store and index.
     * @param source   Provenance label (e.g. "reflection", "user").
     * @param embedding Pre-computed embedding vector for this content.
     *
     * Deduplication: a truncated SHA-256 of the content is checked against
     * the `facts_hash_unique` index before inserting. Exact-duplicate content
     * (same bytes) returns the existing fact's ID immediately without writing
     * anything. The 16-hex-char (64-bit) hash has negligible collision
     * probability at the fact counts this store will realistically handle.
     */
    addFact(content: string, source: string, embedding: number[] | null): string {
      const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

      // Fast path: content already stored — return existing ID.
      const existing = selectByHash.get(hash);
      if (existing) {
        return existing.id;
      }

      const id = crypto.randomUUID();
      const timestamp = Date.now();

      const info = insertFact.run(id, content, source, timestamp, hash);

      // Store embedding when available. Without it the fact is still
      // searchable via FTS5 keyword search; only vector similarity is lost.
      if (embedding !== null) {
        const blob = serializeEmbedding(embedding);
        // Always keep the blob copy in fact_embeddings (backfill source +
        // fallback when sqlite-vec is absent).
        insertEmbedding.run(id, blob);
        // Also insert into the ANN index when the extension is loaded.
        if (insertEmbeddingVec !== null) {
          insertEmbeddingVec.run(BigInt(info.lastInsertRowid), blob);
        }
      }

      return id;
    },

    removeFact(id: string): void {
      // Look up the rowid before deleting the fact row (the row is gone after).
      if (deleteEmbeddingVec !== null) {
        const row = selectRowid.get(id);
        if (row) {
          deleteEmbeddingVec.run(BigInt(row.rowid));
        }
      }
      deleteEmbedding.run(id);
      deleteFact.run(id);
    },

    /**
     * Search facts by keyword using SQLite FTS5.
     *
     * Scoring uses FTS5's built-in BM25 implementation (via the `bm25()`
     * function), which ranks results by term frequency and inverse document
     * frequency. Returns at most `limit` results ordered by relevance.
     */
    searchKeyword(query: string, limit: number): ScoredResult[] {
      if (!query.trim()) {
        return [];
      }

      // Use FTS5 match with BM25 ranking.
      // Wrapping the query in double quotes makes it a phrase query, which
      // neutralises FTS5 operators (OR, AND, NOT, NEAR, *, etc.).
      // Double quotes inside the phrase would break out, so we escape them
      // by doubling ("" is the FTS5 escape for a literal double quote).
      // Single quotes are stripped to avoid tokenizer surprises.
      const escapedQuery = query.replace(/'/g, "").replace(/"/g, '""');

      const stmt = db.prepare(`
        SELECT f.id, f.content, f.source, f.timestamp,
               bm25(facts_fts) as score
        FROM facts_fts
        JOIN facts f ON facts_fts.rowid = f.rowid
        WHERE facts_fts MATCH ?
        ORDER BY bm25(facts_fts)
        LIMIT ?
      `);

      const results = stmt.all(`"${escapedQuery}"`, limit) as Array<{
        id: string;
        content: string;
        source: string;
        timestamp: number;
        score: number;
      }>;

      return results.map((row) => ({
        id: row.id,
        content: row.content,
        source: row.source,
        timestamp: row.timestamp,
        score: row.score,
      }));
    },

    /**
     * Search facts by vector similarity.
     *
     * When sqlite-vec is available, uses the vec0 ANN index (cosine distance)
     * for sub-linear lookup. The cosine distance score (0 = identical, 2 =
     * opposite) is converted back to a 0..1 similarity score so callers see
     * the same value range as the previous full-scan implementation.
     *
     * Falls back to a full table scan when sqlite-vec is not loaded. The scan
     * loads all embeddings into memory and computes cosine similarity for each
     * one. Acceptable up to roughly 100K facts; beyond that the ANN path is
     * required for reasonable latency.
     */
    searchVector(embedding: number[], limit: number): ScoredResult[] {
      const blob = serializeEmbedding(embedding);

      if (vecAvailable) {
        // ANN path: vec0 KNN query returns the nearest neighbours without a
        // full scan. The join to facts retrieves content and metadata.
        const rows = db.prepare(`
          SELECT f.id, f.content, f.source, f.timestamp, v.distance
          FROM fact_embeddings_vec v
          JOIN facts f ON f.rowid = v.rowid
          WHERE v.embedding MATCH ?
            AND k = ?
          ORDER BY v.distance
        `).all(blob, limit) as Array<{
          id: string;
          content: string;
          source: string;
          timestamp: number;
          distance: number;
        }>;

        return rows.map((row) => ({
          id: row.id,
          content: row.content,
          source: row.source,
          timestamp: row.timestamp,
          // Convert cosine distance [0, 2] to similarity [1, -1], clamped to [0, 1].
          score: Math.max(0, 1 - row.distance),
        }));
      }

      // Fallback: full table scan with in-memory cosine similarity.
      const rows = selectEmbeddings.all() as Array<{
        id: string;
        content: string;
        source: string;
        timestamp: number;
        embedding: Buffer;
      }>;

      if (rows.length === 0) {
        return [];
      }

      const scored = rows
        .map((row) => ({
          ...row,
          similarity: cosineSimilarity(embedding, deserializeEmbedding(row.embedding)),
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      return scored.map((row) => ({
        id: row.id,
        content: row.content,
        source: row.source,
        timestamp: row.timestamp,
        score: row.similarity,
      }));
    },

    close(): void {
      db.close();
    },
  };
}
