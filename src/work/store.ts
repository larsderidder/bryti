import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isInternalMessage, type IncomingMessage } from "../channels/types.js";

export type WorkExecution = "queued" | "running" | "completed" | "failed" | "interrupted";
export type WorkDelivery = "none" | "pending" | "delivered" | "failed" | "unknown";

export interface WorkRecord {
  id: string;
  message: IncomingMessage;
  execution: WorkExecution;
  delivery: WorkDelivery;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkStore {
  accept(message: IncomingMessage): { record: WorkRecord; created: boolean };
  get(id: string): WorkRecord | null;
  queued(): WorkRecord[];
  claim(ids: string[]): boolean;
  finish(ids: string[], execution: "completed" | "failed" | "interrupted", error?: string): void;
  recordDelivery(ids: string[], delivery: WorkDelivery, error?: string): void;
  /** A durable outbound record proves the final response was produced. */
  recordResponse(ids: string[], delivery: WorkDelivery, error?: string): void;
  recover(): { queued: WorkRecord[]; interrupted: WorkRecord[] };
  listUnresolved(userId?: string): WorkRecord[];
  close(): void;
}

interface WorkRow {
  id: string;
  message: string;
  execution: WorkExecution;
  delivery: WorkDelivery;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function decode(row: WorkRow): WorkRecord {
  return {
    id: row.id,
    message: JSON.parse(row.message) as IncomingMessage,
    execution: row.execution,
    delivery: row.delivery,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function identity(message: IncomingMessage): string {
  if (message.workId) {
    if (message.workId.length > 512) {
      throw new Error("Work identity is too long");
    }
    return message.workId;
  }
  if (message.messageId) {
    const source = JSON.stringify([message.platform, message.userId, message.channelId, message.messageId]);
    return crypto.createHash("sha256").update(source).digest("hex");
  }
  return crypto.randomUUID();
}

/** Store only normalized input, never the platform's raw object or auth metadata. */
function durableMessage(message: IncomingMessage, id: string): IncomingMessage {
  let raw: unknown = null;
  if (isInternalMessage(message)) {
    const type = (message.raw as { type: string }).type;
    raw = { type };
  }
  return {
    userId: message.userId,
    channelId: message.channelId,
    platform: message.platform,
    threadId: message.threadId,
    channelThreadId: message.channelThreadId,
    messageId: message.messageId,
    workId: id,
    workIds: [id],
    text: message.text,
    images: message.images,
    audio: message.audio,
    replyMode: message.replyMode,
    raw,
  };
}

/** Durable acceptance and execution receipts. Only queued work may be replayed. */
export function createWorkStore(dataDir: string): WorkStore {
  const directory = path.join(dataDir, "work");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const databasePath = path.join(directory, "receipts.db");
  const db = new Database(databasePath);
  fs.chmodSync(databasePath, 0o600);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS work (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      execution TEXT NOT NULL DEFAULT 'queued',
      delivery TEXT NOT NULL DEFAULT 'none',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_execution ON work(execution, created_at);
  `);
  const select = db.prepare("SELECT * FROM work WHERE id = ?");
  const selectQueued = db.prepare("SELECT * FROM work WHERE execution = 'queued' ORDER BY created_at, rowid");
  const insert = db.prepare("INSERT INTO work(id, message, created_at, updated_at) VALUES (?, ?, ?, ?)");
  const get = (id: string): WorkRecord | null => {
    const row = select.get(id) as WorkRow | undefined;
    if (!row) {
      return null;
    }
    return decode(row);
  };
  const queued = (): WorkRecord[] => (selectQueued.all() as WorkRow[]).map(decode);

  return {
    accept: db.transaction((message: IncomingMessage) => {
      const id = identity(message);
      const existing = get(id);
      if (existing) {
        const prior = existing.message;
        if (prior.userId !== message.userId || prior.platform !== message.platform
          || prior.channelId !== message.channelId || prior.channelThreadId !== message.channelThreadId) {
          throw new Error("Work identity belongs to a different destination");
        }
        return { record: existing, created: false };
      }
      const now = new Date().toISOString();
      const normalized = durableMessage(message, id);
      insert.run(id, JSON.stringify(normalized), now, now);
      return { record: get(id)!, created: true };
    }),
    get,
    queued,
    claim: db.transaction((ids: string[]) => {
      const unique = [...new Set(ids)];
      if (unique.length === 0 || unique.some((id) => get(id)?.execution !== "queued")) {
        return false;
      }
      const update = db.prepare("UPDATE work SET execution = 'running', updated_at = ?, message = json_set(message, '$.workIds', json(?)) WHERE id = ?");
      for (const id of unique) {
        update.run(new Date().toISOString(), JSON.stringify(unique), id);
      }
      return true;
    }),
    finish: db.transaction((ids: string[], execution: "completed" | "failed" | "interrupted", error?: string) => {
      const update = db.prepare("UPDATE work SET execution = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ? AND execution = 'running'");
      for (const id of ids) {
        update.run(execution, error ?? null, new Date().toISOString(), id);
      }
    }),
    recordResponse: db.transaction((ids: string[], delivery: WorkDelivery, error?: string) => {
      const update = db.prepare(`UPDATE work SET
        execution = CASE WHEN execution IN ('running', 'interrupted') THEN 'completed' ELSE execution END,
        delivery = CASE WHEN delivery = 'delivered' THEN delivery ELSE ? END,
        error = CASE WHEN execution = 'failed' OR delivery = 'delivered' THEN error ELSE ? END, updated_at = ? WHERE id = ?`);
      for (const id of ids) {
        update.run(delivery, error ?? null, new Date().toISOString(), id);
      }
    }),
    recordDelivery: db.transaction((ids: string[], delivery: WorkDelivery, error?: string) => {
      const update = db.prepare("UPDATE work SET delivery = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ? AND delivery != 'delivered'");
      for (const id of ids) {
        update.run(delivery, error ?? null, new Date().toISOString(), id);
      }
    }),
    recover: db.transaction(() => {
      db.prepare("UPDATE work SET execution = 'interrupted', error = 'Process stopped during execution; not replayed', updated_at = ? WHERE execution = 'running'").run(new Date().toISOString());
      db.prepare("UPDATE work SET delivery = 'unknown', error = COALESCE(error, 'Response delivery awaiting outbound recovery'), updated_at = ? WHERE delivery = 'pending'").run(new Date().toISOString());
      const interrupted = db.prepare("SELECT * FROM work WHERE execution = 'interrupted'").all() as WorkRow[];
      return { queued: queued(), interrupted: interrupted.map(decode) };
    }),
    listUnresolved(userId?: string) {
      const rows = db.prepare(`SELECT * FROM work
        WHERE (execution IN ('failed', 'interrupted') OR delivery IN ('pending', 'failed', 'unknown'))
          AND (? IS NULL OR json_extract(message, '$.userId') = ?)
        ORDER BY created_at DESC LIMIT 100`).all(userId ?? null, userId ?? null) as WorkRow[];
      return rows.map(decode);
    },
    close() {
      db.close();
    },
  };
}
