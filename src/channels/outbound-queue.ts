import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ApprovalResult, ChannelBridge, IncomingMessage, Platform, SendOpts } from "./types.js";

interface OutboundRecord {
  id: string;
  platform: Platform;
  channelId: string;
  text: string;
  opts?: SendOpts;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

const RECORD_ID_PATTERN = /^[0-9a-f-]{36}$/i;

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function isOutboundRecord(value: unknown, platform: Platform): value is OutboundRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<OutboundRecord>;
  return (
    record.platform === platform &&
    typeof record.id === "string" &&
    RECORD_ID_PATTERN.test(record.id) &&
    typeof record.channelId === "string" &&
    typeof record.text === "string" &&
    typeof record.attempts === "number" &&
    Number.isInteger(record.attempts) &&
    record.attempts >= 0 &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

export class DurableOutboundBridge implements ChannelBridge {
  readonly name: string;
  readonly platform: Platform;

  private readonly queueDir: string;
  private drainTimer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly inner: ChannelBridge,
    dataDir: string,
    private readonly maxAttempts = 8,
  ) {
    this.name = inner.name;
    this.platform = inner.platform;
    this.queueDir = path.join(dataDir, "pending", "outbound", inner.platform);
  }

  async start(): Promise<void> {
    ensureDir(this.queueDir);
    await this.inner.start();
    await this.drain();
    this.drainTimer = setInterval(() => void this.drain(), 30_000);
  }

  async stop(): Promise<void> {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    await this.inner.stop();
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.inner.onMessage(handler);
  }

  async sendMessage(channelId: string, text: string, opts?: SendOpts): Promise<string> {
    const record = this.createRecord(channelId, text, opts);
    this.save(record);
    try {
      const messageId = await this.inner.sendMessage(channelId, text, opts);
      this.remove(record.id);
      return messageId;
    } catch (error) {
      record.attempts += 1;
      record.updatedAt = new Date().toISOString();
      record.lastError = safeError(error);
      this.save(record);
      throw error;
    }
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    await this.inner.editMessage(channelId, messageId, text);
  }

  async sendTyping(channelId: string, opts?: SendOpts): Promise<void> {
    await this.inner.sendTyping(channelId, opts);
  }

  async sendApprovalRequest(
    channelId: string,
    prompt: string,
    approvalKey: string,
    timeoutMs?: number,
    opts?: SendOpts,
  ): Promise<ApprovalResult> {
    return this.inner.sendApprovalRequest(channelId, prompt, approvalKey, timeoutMs, opts);
  }

  private createRecord(channelId: string, text: string, opts?: SendOpts): OutboundRecord {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      platform: this.platform,
      channelId,
      text,
      opts,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  private pathFor(id: string): string {
    return path.join(this.queueDir, `${id}.json`);
  }

  private save(record: OutboundRecord): void {
    ensureDir(this.queueDir);
    writeJsonAtomic(this.pathFor(record.id), record);
  }

  private remove(id: string): void {
    fs.rmSync(this.pathFor(id), { force: true });
  }

  private readRecords(): OutboundRecord[] {
    ensureDir(this.queueDir);
    const records: OutboundRecord[] = [];
    for (const entry of fs.readdirSync(this.queueDir)) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(this.queueDir, entry);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (isOutboundRecord(parsed, this.platform)) {
          records.push(parsed);
        } else {
          console.warn(`[outbound] Ignoring invalid queue file ${filePath}`);
        }
      } catch (error) {
        console.warn(`[outbound] Ignoring unreadable queue file ${filePath}: ${safeError(error)}`);
      }
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const record of this.readRecords()) {
        if (record.attempts >= this.maxAttempts) continue;
        try {
          await this.inner.sendMessage(record.channelId, record.text, record.opts);
          this.remove(record.id);
        } catch (error) {
          record.attempts += 1;
          record.updatedAt = new Date().toISOString();
          record.lastError = safeError(error);
          this.save(record);
          console.warn(`[outbound] Delivery failed for ${record.id}: ${record.lastError}`);
          break;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

export function withDurableOutbound(bridge: ChannelBridge, dataDir: string): ChannelBridge {
  return new DurableOutboundBridge(bridge, dataDir);
}
