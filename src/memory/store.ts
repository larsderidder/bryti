/**
 * Memory store using SQLite with FTS5 (keyword search).
 *
 * Per-user database with:
 * - facts table: id, content, source, timestamp, hash
 * - facts_fts FTS5 virtual table: keyword search over facts.content
 * - facts_vec table: stores embeddings for manual vector similarity computation
 *
 * Note: Vector search is implemented manually using cosine similarity
 * since sqlite-vec has loading issues in this environment.
 */

import Database from "better-sqlite3";
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
  /** Add a fact to the store. Returns the fact ID. */
  addFact(content: string, source: string, embedding: number[]): string;

  /** Remove a fact by ID. */
  removeFact(id: string): void;

  /** Search using keyword (FTS5). */
  searchKeyword(query: string, limit: number): ScoredResult[];

  /** Search using vector similarity (in-memory cosine similarity). */
  searchVector(embedding: number[], limit: number): ScoredResult[];

  /** Get all facts (for vector search). */
  getAllFacts(): Array<{ id: string; content: string; source: string; timestamp: number; embedding: number[] }>;

  /** Close the database connection. */
  close(): void;
}

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Create a per-user memory store.
 *
 * @param userId User ID for isolation
 * @param dataDir Base data directory
 */
export function createMemoryStore(userId: string, dataDir: string): MemoryStore {
  const userDir = path.join(dataDir, "users", userId);
  fs.mkdirSync(userDir, { recursive: true });

  const dbPath = path.join(userDir, "memory.db");
  const db = new Database(dbPath);

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

    -- Table to store embeddings (JSON serialized)
    CREATE TABLE IF NOT EXISTS fact_embeddings (
      id TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      FOREIGN KEY (id) REFERENCES facts(id) ON DELETE CASCADE
    );
  `);

  // Prepared statements for efficiency
  const insertFact = db.prepare(`
    INSERT INTO facts (id, content, source, timestamp, hash)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertEmbedding = db.prepare(`
    INSERT INTO fact_embeddings (id, embedding) VALUES (?, ?)
  `);

  const deleteFact = db.prepare(`
    DELETE FROM facts WHERE id = ?
  `);

  const deleteEmbedding = db.prepare(`
    DELETE FROM fact_embeddings WHERE id = ?
  `);

  const selectAll = db.prepare(`
    SELECT f.id, f.content, f.source, f.timestamp, fe.embedding
    FROM facts f
    LEFT JOIN fact_embeddings fe ON f.id = fe.id
  `);

  return {
    addFact(content: string, source: string, embedding: number[]): string {
      const id = crypto.randomUUID();
      const timestamp = Date.now();
      const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

      // Insert into facts table
      insertFact.run(id, content, source, timestamp, hash);

      // Insert embedding as JSON
      insertEmbedding.run(id, JSON.stringify(embedding));

      return id;
    },

    removeFact(id: string): void {
      deleteEmbedding.run(id);
      deleteFact.run(id);
    },

    searchKeyword(query: string, limit: number): ScoredResult[] {
      if (!query.trim()) {
        return [];
      }

      // Use FTS5 match with BM25 ranking
      // Escape special FTS5 characters
      const escapedQuery = query.replace(/['"]/g, "");
      
      // Use parameterized query for safety
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

    searchVector(embedding: number[], limit: number): ScoredResult[] {
      // Get all facts with embeddings
      const facts = this.getAllFacts();
      
      if (facts.length === 0) {
        return [];
      }

      // Compute cosine similarity for each fact
      const scored = facts
        .map((fact) => ({
          ...fact,
          similarity: cosineSimilarity(embedding, fact.embedding),
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

    getAllFacts(): Array<{ id: string; content: string; source: string; timestamp: number; embedding: number[] }> {
      const rows = selectAll.all() as Array<{
        id: string;
        content: string;
        source: string;
        timestamp: number;
        embedding: string | null;
      }>;

      return rows
        .filter((row) => row.embedding !== null)
        .map((row) => ({
          id: row.id,
          content: row.content,
          source: row.source,
          timestamp: row.timestamp,
          embedding: JSON.parse(row.embedding!),
        }));
    },

    close(): void {
      db.close();
    },
  };
}

/**
 * Get the database path for a user.
 */
export function getMemoryDbPath(userId: string, dataDir: string): string {
  return path.join(dataDir, "users", userId, "memory.db");
}
