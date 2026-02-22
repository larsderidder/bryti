/**
 * Per-user memory store backed by SQLite with FTS5 for keyword search and
 * binary Float32Array blobs for embeddings. Vector search runs in-memory
 * via cosine similarity.
 */

import Database from "better-sqlite3";
import { cosineSimilarity } from "../math.js";
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

  /** Close the database connection. */
  close(): void;
}



function serializeEmbedding(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

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

    -- Table to store embeddings (binary Float32Array)
    CREATE TABLE IF NOT EXISTS fact_embeddings (
      id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
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

  const selectEmbeddings = db.prepare(`
    SELECT f.id, f.content, f.source, f.timestamp, fe.embedding
    FROM facts f
    JOIN fact_embeddings fe ON f.id = fe.id
  `);

  return {
    addFact(content: string, source: string, embedding: number[]): string {
      const id = crypto.randomUUID();
      const timestamp = Date.now();
      const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

      // Insert into facts table
      insertFact.run(id, content, source, timestamp, hash);

      // Insert embedding as binary blob
      insertEmbedding.run(id, serializeEmbedding(embedding));

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

      // Compute cosine similarity for each fact
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


