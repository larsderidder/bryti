import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { IncomingMessage } from "../channels/types.js";
import { hashToolArgs } from "../trust/store.js";
import { toolError } from "../tools/result.js";
import { DEFAULT_THREAD_ID } from "../threads.js";

// Only application-owned tools opt in. Extension and MCP descriptions grant no replay policy.
const EFFECT_TOOLS = new Set(["file_write", "memory_core_append", "memory_core_replace",
  "memory_archival_insert", "projection_create", "projection_resolve", "projection_link", "skill_install", "pi_session_inject"]);
const MAX_RESULT_BYTES = 256 * 1024;

export interface EffectReceipt {
  id: string;
  owner: Pick<IncomingMessage, "userId" | "platform" | "channelId" | "channelThreadId" | "threadId">;
  workIds: string[];
  callId: string;
  toolName: string;
  argsHash: string;
  implementation: string;
  guidelinesHash?: string;
  sessionId?: string;
  assistantTimestamp?: number;
  state: "running" | "completed" | "unknown";
  result?: AgentToolResult<unknown>;
  createdAt: string;
}

/** Effect records never authorize execution and never trigger automatic replay. */
export function withEffectStore<T>(dataDir: string, operation: (store: EffectStore) => T): T {
  const store = new EffectStore(dataDir);
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

export class EffectStore {
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
    this.db.exec("CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY, record TEXT NOT NULL)");
    this.db.exec("CREATE INDEX IF NOT EXISTS effects_lookup ON effects (json_extract(record, '$.owner.userId'), json_extract(record, '$.callId'), json_extract(record, '$.sessionId'))");
  }

  list(userId?: string): EffectReceipt[] {
    const rows = this.db.prepare("SELECT record FROM effects WHERE (? IS NULL OR json_extract(record, '$.owner.userId') = ?) ORDER BY rowid DESC")
      .all(userId ?? null, userId ?? null) as Array<{ record: string }>;
    return rows.map((row) => JSON.parse(row.record) as EffectReceipt);
  }

  find(userId: string, threadId: string | undefined, callId: string, toolName: string, argsHash: string,
    sessionId?: string, assistantTimestamp?: number,
  ): EffectReceipt[] {
    const rows = this.db.prepare(`SELECT record FROM effects
      WHERE json_extract(record, '$.owner.userId') = ? AND json_extract(record, '$.callId') = ?
        AND json_extract(record, '$.toolName') = ? AND json_extract(record, '$.argsHash') = ?
        AND COALESCE(json_extract(record, '$.owner.threadId'), ?) = ?
        AND json_extract(record, '$.sessionId') IS ? AND json_extract(record, '$.assistantTimestamp') IS ?
      LIMIT 2`).all(userId, callId, toolName, argsHash, DEFAULT_THREAD_ID, threadId ?? DEFAULT_THREAD_ID, sessionId ?? null,
      assistantTimestamp ?? null) as Array<{ record: string }>;
    return rows.map((row) => JSON.parse(row.record) as EffectReceipt);
  }

  accept(owner: IncomingMessage, callId: string, toolName: string, args: unknown, implementation: string,
    guidelinesHash?: string, conversation?: Pick<EffectReceipt, "sessionId" | "assistantTimestamp">,
  ): { receipt: EffectReceipt; created: boolean } {
    return this.db.transaction(() => {
      const workIds = [...new Set(owner.workIds ?? [owner.workId!])].sort();
      if (workIds.length === 0 || workIds.some((id) => {
        const parent = this.db.prepare("SELECT execution, message FROM work WHERE id = ?").get(id) as { execution: string; message: string } | undefined;
        if (!parent || parent.execution !== "running") {
          return true;
        }
        const target = JSON.parse(parent.message) as IncomingMessage;
        return target.userId !== owner.userId || target.platform !== owner.platform || target.channelId !== owner.channelId
          || target.channelThreadId !== owner.channelThreadId || (target.threadId ?? DEFAULT_THREAD_ID) !== (owner.threadId ?? DEFAULT_THREAD_ID);
      })) {
        throw new Error("An active owning work receipt is required for this effect");
      }
      const scope = { userId: owner.userId, platform: owner.platform, channelId: owner.channelId,
        threadId: owner.threadId ?? DEFAULT_THREAD_ID, channelThreadId: owner.channelThreadId };
      const id = hashToolArgs([scope, workIds, callId]);
      const row = this.db.prepare("SELECT record FROM effects WHERE id = ?").get(id) as { record: string } | undefined;
      const argsHash = hashToolArgs(args);
      if (row) {
        const receipt = JSON.parse(row.record) as EffectReceipt;
        if (receipt.toolName !== toolName || receipt.argsHash !== argsHash) {
          throw new Error("Effect identity was reused with different arguments");
        }
        return { receipt, created: false };
      }
      const receipt: EffectReceipt = { id, owner: scope, workIds, callId, toolName, argsHash,
        implementation, guidelinesHash, ...conversation, state: "running", createdAt: new Date().toISOString() };
      this.db.prepare("INSERT INTO effects(id, record) VALUES (?, ?)").run(id, JSON.stringify(receipt));
      return { receipt, created: true };
    })();
  }

  finish(id: string, result?: AgentToolResult<unknown>): void {
    const row = this.db.prepare("SELECT record FROM effects WHERE id = ?").get(id) as { record: string } | undefined;
    if (!row) {
      throw new Error("Effect receipt disappeared before settlement");
    }
    const receipt = JSON.parse(row.record) as EffectReceipt;
    receipt.state = "unknown";
    if (result && Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES) {
      receipt.state = "completed";
      receipt.result = result;
    }
    this.db.prepare("UPDATE effects SET record = ? WHERE id = ?").run(JSON.stringify(receipt), id);
  }

  recover(): void {
    this.db.prepare("UPDATE effects SET record = json_set(record, '$.state', 'unknown') WHERE json_extract(record, '$.state') = 'running'").run();
  }

  close(): void {
    this.db.close();
  }
}

/** Place inside the trust wrapper so every fresh execution receives current permission checks. */
export function wrapEffectTool<T extends AgentTool<any>>(
  tool: T, dataDir: string, getOwner: () => IncomingMessage | undefined | null, getGuidelines?: () => string,
  getConversation?: () => Pick<EffectReceipt, "sessionId" | "assistantTimestamp"> | undefined,
): T {
  if (!EFFECT_TOOLS.has(tool.name)) {
    return tool;
  }
  const implementation = crypto.createHash("sha256").update(tool.execute.toString()).digest("hex");
  return { ...tool, async execute(callId, args, signal, onUpdate) {
    const owner = getOwner();
    if (!owner?.workId) {
      return toolError("An active accepted work receipt is required for this action");
    }
    if (signal?.aborted) {
      return toolError("Action cancelled before durable acceptance");
    }
    const guidelines = getGuidelines?.();
    let guidelinesHash: string | undefined;
    if (guidelines !== undefined) {
      guidelinesHash = hashToolArgs(guidelines);
    }
    const accepted = withEffectStore(dataDir, (store) => store.accept(owner, callId, tool.name, args, implementation, guidelinesHash, getConversation?.()));
    if (!accepted.created) {
      if (accepted.receipt.result) {
        return accepted.receipt.result;
      }
      return toolError(`Effect receipt ${accepted.receipt.id}: outcome unknown. The action may have completed. Inspect its outcome; do not repeat side effects.`);
    }
    let result: AgentToolResult<unknown>;
    try {
      result = await tool.execute(callId, args, signal, onUpdate);
    } catch (error) {
      withEffectStore(dataDir, (store) => store.finish(accepted.receipt.id));
      throw error;
    }
    // Failure here leaves the durable intent unresolved, never permission to execute again.
    withEffectStore(dataDir, (store) => store.finish(accepted.receipt.id, result));
    return result;
  } } as T;
}

/** Restore only an unambiguous matching receipt, without executing a tool. */
export function resolveEffectResult(
  dataDir: string, userId: string, threadId: string | undefined,
  call: { id: string; name?: string; arguments?: unknown; assistantTimestamp?: number }, sessionId?: string,
): Extract<AgentMessage, { role: "toolResult" }> | undefined {
  if (!call.name || call.arguments === undefined) {
    return undefined;
  }
  const matches = withEffectStore(dataDir, (store) => store.find(userId, threadId, call.id, call.name!,
    hashToolArgs(call.arguments), sessionId, call.assistantTimestamp));
  if (matches.length !== 1) {
    return undefined;
  }
  const receipt = matches[0];
  let result = receipt.result;
  let isError = false;
  if (!result) {
    result = toolError(`Effect receipt ${receipt.id}: outcome unknown. It may have completed. Inspect its outcome; do not repeat side effects.`);
    isError = true;
  } else {
    isError = Boolean((result.details as { error?: unknown } | undefined)?.error);
  }
  return { role: "toolResult", toolCallId: call.id, toolName: call.name,
    content: result.content, details: result.details, isError, timestamp: Date.parse(receipt.createdAt) } as Extract<AgentMessage, { role: "toolResult" }>;
}
