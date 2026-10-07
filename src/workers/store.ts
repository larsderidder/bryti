import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { IncomingMessage } from "../channels/types.js";
import type { WorkerStatus } from "./registry.js";
import type { WorkerProgress } from "./tracker.js";
import { DEFAULT_THREAD_ID } from "../threads.js";

export interface WorkerLaunchSpec {
  task: string;
  modelOverride?: string;
  modelCandidates?: string[];
  thinkingLevel?: Config["tools"]["workers"]["thinking_level"];
  toolNames: Array<"web_search" | "fetch_url">;
  timeoutMs: number;
  maxTurns?: number;
  owner?: IncomingMessage;
}

export interface WorkerReceipt {
  workerId: string;
  identity: string;
  spec: WorkerLaunchSpec;
  argsHash?: string;
  model: string;
  status: WorkerStatus;
  createdAt: string;
  queueOrder?: number;
  startedAt: string | null;
  completedAt: string | null;
  deadlineAt: string | null;
  sessionId: string;
  pendingSteering: string | null;
  steeringAcceptedAt?: number;
  stopStatus: "cancelled" | "timeout" | "interrupted" | null;
  error: string | null;
  resultHash: string | null;
  progress?: WorkerProgress;
  eventPending: boolean;
}

/** Bind dispatch and continuation to accepted work, not just a provider call ID. */
export function workerIdentity(owner: IncomingMessage | undefined, callId: string, fallbackScope: string): string {
  let scope: unknown = fallbackScope;
  if (owner?.workId) {
    scope = [owner.userId, owner.platform, owner.channelId, owner.threadId ?? DEFAULT_THREAD_ID, owner.channelThreadId,
      [...new Set(owner.workIds ?? [owner.workId])].sort()];
  }
  return crypto.createHash("sha256").update(JSON.stringify([scope, callId])).digest("hex");
}

export function sameWorkerOwner(left: IncomingMessage | undefined, right: IncomingMessage | undefined): boolean {
  return Boolean(left && right && left.userId === right.userId && left.platform === right.platform
    && left.channelId === right.channelId && (left.threadId ?? DEFAULT_THREAD_ID) === (right.threadId ?? DEFAULT_THREAD_ID)
    && left.channelThreadId === right.channelThreadId);
}

/** Short-lived connections avoid coupling accepted workers to chat-session disposal. */
export function withWorkerStore<T>(dataDir: string, operation: (store: WorkerStore) => T): T {
  const store = new WorkerStore(dataDir);
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

export class WorkerStore {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    const directory = path.join(dataDir, "work");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "receipts.db");
    this.db = new Database(file);
    fs.chmodSync(file, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, record TEXT NOT NULL
    )`);
  }

  get(workerId: string): WorkerReceipt | null {
    const row = this.db.prepare("SELECT record FROM workers WHERE id = ?").get(workerId) as { record: string } | undefined;
    if (!row) {
      return null;
    }
    return JSON.parse(row.record) as WorkerReceipt;
  }

  list(): WorkerReceipt[] {
    const rows = this.db.prepare("SELECT record FROM workers ORDER BY rowid").all() as Array<{ record: string }>;
    return rows.map((row) => JSON.parse(row.record) as WorkerReceipt);
  }

  accept(identity: string, spec: WorkerLaunchSpec, model: string, prior?: WorkerReceipt, argsHash?: string): WorkerReceipt {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT record FROM workers WHERE identity = ?").get(identity) as { record: string } | undefined;
      if (existing) {
        const receipt = JSON.parse(existing.record) as WorkerReceipt;
        let matches = JSON.stringify(receipt.spec) === JSON.stringify(spec);
        if (receipt.argsHash && argsHash) {
          matches = receipt.argsHash === argsHash;
        }
        if (!matches || (prior && receipt.sessionId !== prior.sessionId)) {
          throw new Error("Worker call identity was reused with different arguments");
        }
        return receipt;
      }
      if (prior && this.list().some((record) => record.sessionId === prior.sessionId
        && ["queued", "running", "stopping"].includes(record.status))) {
        throw new Error("This worker conversation already has an active continuation");
      }
      const workerId = `w-${crypto.randomBytes(4).toString("hex")}`;
      const receipt: WorkerReceipt = {
        workerId, identity, argsHash, spec, model, status: "queued", createdAt: new Date().toISOString(),
        startedAt: null, completedAt: null, deadlineAt: prior?.deadlineAt ?? null,
        sessionId: prior?.sessionId ?? workerId, pendingSteering: prior?.pendingSteering ?? null,
        steeringAcceptedAt: prior?.steeringAcceptedAt,
        stopStatus: null, error: null, resultHash: null, progress: prior?.progress, eventPending: false,
      };
      const inserted = this.db.prepare("INSERT INTO workers(id, identity, record) VALUES (?, ?, ?)")
        .run(workerId, identity, JSON.stringify(receipt));
      receipt.queueOrder = Number(inserted.lastInsertRowid);
      this.save(receipt);
      return receipt;
    })();
  }

  claim(workerId: string): WorkerReceipt | null {
    return this.db.transaction(() => {
      const receipt = this.get(workerId);
      if (!receipt || receipt.status !== "queued") {
        return null;
      }
      const now = new Date().toISOString();
      receipt.status = "running";
      receipt.startedAt = now;
      receipt.deadlineAt ??= new Date(Date.now() + receipt.spec.timeoutMs).toISOString();
      this.save(receipt);
      return receipt;
    })();
  }

  steer(workerId: string, guidance: string | null): void {
    const receipt = this.get(workerId);
    if (receipt && ["queued", "running"].includes(receipt.status)) {
      receipt.pendingSteering = guidance;
      receipt.steeringAcceptedAt = Date.now();
      this.save(receipt);
    }
  }

  /** Queuing guidance is not delivery; retain it until its user entry is persisted. */
  confirmSteering(workerId: string, text: string, timestamp: number): void {
    const receipt = this.get(workerId);
    if (receipt?.pendingSteering === text && timestamp >= (receipt.steeringAcceptedAt ?? 0)) {
      receipt.pendingSteering = null;
      this.save(receipt);
    }
  }

  requestStop(workerId: string, status: "cancelled" | "timeout" | "interrupted", error: string | null): void {
    const receipt = this.get(workerId);
    if (!receipt || !["running", "queued"].includes(receipt.status)) {
      return;
    }
    receipt.stopStatus = status;
    receipt.error = error;
    receipt.status = "stopping";
    this.save(receipt);
  }

  /** The terminal outcome and pending reporting event are one SQLite commit. */
  finish(workerId: string, status: WorkerStatus, error: string | null, resultHash?: string, progress?: WorkerProgress): void {
    const receipt = this.get(workerId);
    if (!receipt || !["queued", "running", "stopping"].includes(receipt.status)) {
      return;
    }
    if (status === "running" || status === "queued" || status === "stopping") {
      throw new Error("Worker settlement must be terminal");
    }
    receipt.status = receipt.stopStatus ?? status;
    receipt.completedAt = new Date().toISOString();
    receipt.error = error ?? receipt.error;
    receipt.resultHash = resultHash ?? null;
    receipt.progress = progress ?? receipt.progress;
    receipt.eventPending = true;
    this.save(receipt);
  }

  acknowledge(workerId: string): void {
    const receipt = this.get(workerId);
    if (receipt) {
      receipt.eventPending = false;
      this.save(receipt);
    }
  }

  recover(): void {
    this.db.transaction(() => {
      for (const receipt of this.list()) {
        if (receipt.status === "running" || receipt.status === "stopping") {
          this.finish(receipt.workerId, "interrupted", receipt.error ?? "Bryti stopped during execution. It was not replayed.");
        }
      }
    })();
  }

  private save(receipt: WorkerReceipt): void {
    this.db.prepare("UPDATE workers SET record = ? WHERE id = ?").run(JSON.stringify(receipt), receipt.workerId);
  }

  close(): void {
    this.db.close();
  }
}
