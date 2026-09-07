import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDeliveryError, safeDeliveryErrorMessage } from "./delivery.js";
import type { DeliveryError } from "./delivery.js";
import type { ApprovalResult, ChannelBridge, IncomingMessage, Platform, SendOpts } from "./types.js";
import { writeJsonAtomic } from "../durable-file.js";

type OutboundState = "pending" | "sending" | "delivered" | "failed" | "unknown";
type OutboundKind = "message" | "voice";
type DurableSendOpts = SendOpts & { workIds?: string[]; caption?: string };
type OutcomeState = "pending" | "delivered" | "failed" | "unknown";

export interface OutboundOutcomeEvent {
  workIds: string[];
  state: OutcomeState;
  error?: string;
}

export interface DurableOutboundOptions {
  maxAttempts?: number;
  drainIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onOutcome?: (event: OutboundOutcomeEvent) => void | Promise<void>;
}

interface StoredSendOpts {
  parseMode?: SendOpts["parseMode"];
  channelThreadId?: string;
  caption?: string;
}

interface OutboundRecord {
  id: string;
  kind: OutboundKind;
  platform: Platform;
  channelId: string;
  text: string;
  opts?: StoredSendOpts;
  attempts: number;
  state: OutboundState;
  workIds: string[];
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  messageId?: string;
  lastError?: string;
  outcomeNotifiedAt?: string;
  voiceFileName?: string;
}

const RECORD_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_DRAIN_INTERVAL_MS = 30_000;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const VOICE_RECORD_TEXT = "voice reply";

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}


function sanitizeSendOpts(opts?: DurableSendOpts): StoredSendOpts | undefined {
  if (!opts) {
    return undefined;
  }

  const stored: StoredSendOpts = {};
  if (opts.parseMode) {
    stored.parseMode = opts.parseMode;
  }
  if (opts.channelThreadId) {
    stored.channelThreadId = opts.channelThreadId;
  }
  if (opts.caption) {
    stored.caption = opts.caption;
  }

  if (Object.keys(stored).length === 0) {
    return undefined;
  }
  return stored;
}

function workIdsFromOpts(opts?: DurableSendOpts): string[] {
  if (!Array.isArray(opts?.workIds)) {
    return [];
  }
  return opts.workIds.filter((workId) => typeof workId === "string" && workId.length > 0);
}

function normalizeOptions(optionsOrMaxAttempts: number | DurableOutboundOptions): Required<Omit<DurableOutboundOptions, "onOutcome">> & Pick<DurableOutboundOptions, "onOutcome"> {
  let options: DurableOutboundOptions = {};
  if (typeof optionsOrMaxAttempts === "number") {
    options = { maxAttempts: optionsOrMaxAttempts };
  } else {
    options = optionsOrMaxAttempts;
  }

  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  if (Number.isInteger(options.maxAttempts) && options.maxAttempts! > 0) {
    maxAttempts = options.maxAttempts!;
  }

  let drainIntervalMs = DEFAULT_DRAIN_INTERVAL_MS;
  if (Number.isInteger(options.drainIntervalMs) && options.drainIntervalMs! > 0) {
    drainIntervalMs = options.drainIntervalMs!;
  }

  let baseBackoffMs = DEFAULT_BASE_BACKOFF_MS;
  if (Number.isInteger(options.baseBackoffMs) && options.baseBackoffMs! > 0) {
    baseBackoffMs = options.baseBackoffMs!;
  }

  let maxBackoffMs = DEFAULT_MAX_BACKOFF_MS;
  if (Number.isInteger(options.maxBackoffMs) && options.maxBackoffMs! > 0) {
    maxBackoffMs = options.maxBackoffMs!;
  }

  return {
    maxAttempts,
    drainIntervalMs,
    baseBackoffMs,
    maxBackoffMs,
    onOutcome: options.onOutcome,
  };
}

function isStoredSendOpts(value: unknown): value is StoredSendOpts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const opts = value as Partial<StoredSendOpts>;
  if (opts.parseMode && !["markdown", "html", "plain"].includes(opts.parseMode)) {
    return false;
  }
  if (opts.channelThreadId && typeof opts.channelThreadId !== "string") {
    return false;
  }
  if (opts.caption && typeof opts.caption !== "string") {
    return false;
  }
  return true;
}

function isOutboundState(value: unknown): value is OutboundState {
  return value === "pending"
    || value === "sending"
    || value === "delivered"
    || value === "failed"
    || value === "unknown";
}

function isOutboundKind(value: unknown): value is OutboundKind {
  return value === "message" || value === "voice";
}

function shouldAttempt(record: OutboundRecord): boolean {
  if (record.kind !== "message") {
    return false;
  }
  if (record.state !== "pending") {
    return false;
  }
  if (!record.nextAttemptAt) {
    return true;
  }
  return Date.parse(record.nextAttemptAt) <= Date.now();
}

function terminalOutcomeFor(record: OutboundRecord): OutcomeState | null {
  if (record.state === "delivered") {
    return "delivered";
  }
  if (record.state === "failed") {
    return "failed";
  }
  if (record.state === "unknown") {
    return "unknown";
  }
  return null;
}

function failureCategory(error: DeliveryError): string {
  if (error.outcome === "unknown") {
    return "delivery_unknown";
  }
  if (error.retryable) {
    return "retryable_not_sent";
  }
  return "permanent_not_sent";
}

function isOutboundRecord(value: unknown, platform: Platform): value is OutboundRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<OutboundRecord>;
  const kind = record.kind ?? "message";
  return record.platform === platform
    && isOutboundKind(kind)
    && typeof record.id === "string"
    && RECORD_ID_PATTERN.test(record.id)
    && typeof record.channelId === "string"
    && typeof record.text === "string"
    && typeof record.attempts === "number"
    && Number.isInteger(record.attempts)
    && record.attempts >= 0
    && isOutboundState(record.state)
    && Array.isArray(record.workIds)
    && record.workIds.every((workId) => typeof workId === "string")
    && (record.opts == null || isStoredSendOpts(record.opts))
    && typeof record.createdAt === "string"
    && typeof record.updatedAt === "string";
}

export class DurableOutboundBridge implements ChannelBridge {
  readonly name: string;
  readonly platform: Platform;
  sendVoice?: ChannelBridge["sendVoice"];

  private readonly queueDir: string;
  private readonly options: Required<Omit<DurableOutboundOptions, "onOutcome">> & Pick<DurableOutboundOptions, "onOutcome">;
  private drainTimer: NodeJS.Timeout | null = null;
  private activeDrain: Promise<void> | null = null;
  private draining = false;
  private readonly activeSends = new Set<Promise<unknown>>();
  private readonly activeCallbacks = new Set<Promise<void>>();

  constructor(
    private readonly inner: ChannelBridge,
    dataDir: string,
    optionsOrMaxAttempts: number | DurableOutboundOptions = {},
  ) {
    this.name = inner.name;
    this.platform = inner.platform;
    this.queueDir = path.join(dataDir, "pending", "outbound", inner.platform);
    this.options = normalizeOptions(optionsOrMaxAttempts);

    if (inner.sendVoice) {
      this.sendVoice = async (channelId, audioPath, opts) => {
        const durableOpts = opts as DurableSendOpts | undefined;
        const record = this.createVoiceRecord(channelId, audioPath, durableOpts);
        this.save(record);
        this.emitOutcome(record, "pending");
        return await this.trackSend(this.sendVoiceRecord(record, audioPath, durableOpts));
      };
    }
  }

  async start(): Promise<void> {
    ensureDir(this.queueDir);
    const recovered = this.recoverInterruptedSending();
    this.reemitUnnotifiedTerminalOutcomes(recovered);
    await this.inner.start();
    await this.drain();
    this.drainTimer = setInterval(() => void this.drain(), this.options.drainIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.activeDrain) {
      await this.activeDrain;
    }
    await this.waitForActiveSends();
    await this.waitForActiveCallbacks();
    await this.inner.stop();
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.inner.onMessage(handler);
  }

  async sendMessage(channelId: string, text: string, opts?: SendOpts): Promise<string> {
    const record = this.createMessageRecord(channelId, text, opts as DurableSendOpts | undefined);
    this.save(record);
    this.emitOutcome(record, "pending");
    return await this.trackSend(this.sendMessageRecord(record));
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

  private createMessageRecord(channelId: string, text: string, opts?: DurableSendOpts): OutboundRecord {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      kind: "message",
      platform: this.platform,
      channelId,
      text,
      opts: sanitizeSendOpts(opts),
      attempts: 0,
      state: "pending",
      workIds: workIdsFromOpts(opts),
      createdAt: now,
      updatedAt: now,
    };
  }

  private createVoiceRecord(channelId: string, audioPath: string, opts?: DurableSendOpts): OutboundRecord {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      kind: "voice",
      platform: this.platform,
      channelId,
      text: VOICE_RECORD_TEXT,
      opts: sanitizeSendOpts(opts),
      attempts: 0,
      state: "sending",
      workIds: workIdsFromOpts(opts),
      createdAt: now,
      updatedAt: now,
      voiceFileName: path.basename(audioPath),
    };
  }

  private pathFor(id: string): string {
    return path.join(this.queueDir, `${id}.json`);
  }

  private save(record: OutboundRecord): void {
    ensureDir(this.queueDir);
    writeJsonAtomic(this.pathFor(record.id), record);
  }

  private readRecords(): OutboundRecord[] {
    ensureDir(this.queueDir);
    const records: OutboundRecord[] = [];
    for (const entry of fs.readdirSync(this.queueDir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(this.queueDir, entry);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (isOutboundRecord(parsed, this.platform)) {
          records.push({ ...parsed, kind: parsed.kind ?? "message" });
        } else {
          console.warn(`[outbound] Ignoring invalid queue file ${filePath}`);
        }
      } catch {
        console.warn(`[outbound] Ignoring unreadable queue file ${filePath}`);
      }
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async sendMessageRecord(record: OutboundRecord): Promise<string> {
    record.attempts += 1;
    record.state = "sending";
    record.updatedAt = new Date().toISOString();
    delete record.nextAttemptAt;
    this.save(record);

    try {
      const messageId = await this.inner.sendMessage(record.channelId, record.text, record.opts);
      this.applySuccess(record, messageId);
      return messageId;
    } catch (error) {
      const deliveryError = ensureDeliveryError(error);
      this.applyFailure(record, deliveryError, { allowRetry: true });
      throw deliveryError;
    }
  }

  private async sendVoiceRecord(record: OutboundRecord, audioPath: string, opts?: DurableSendOpts): Promise<string> {
    record.attempts += 1;
    record.state = "sending";
    record.updatedAt = new Date().toISOString();
    delete record.nextAttemptAt;
    this.save(record);

    try {
      const messageId = await this.inner.sendVoice!(record.channelId, audioPath, opts);
      this.applySuccess(record, messageId);
      return messageId;
    } catch (error) {
      const deliveryError = ensureDeliveryError(error);
      this.applyFailure(record, deliveryError, { allowRetry: false });
      throw deliveryError;
    }
  }

  private applySuccess(record: OutboundRecord, messageId: string): void {
    record.state = "delivered";
    record.messageId = messageId;
    record.updatedAt = new Date().toISOString();
    delete record.lastError;
    delete record.nextAttemptAt;
    this.save(record);
    this.emitOutcome(record, "delivered");
  }

  private applyFailure(record: OutboundRecord, error: DeliveryError, options: { allowRetry: boolean }): void {
    const category = failureCategory(error);
    record.updatedAt = new Date().toISOString();
    record.lastError = category;

    if (options.allowRetry && error.outcome === "not_sent" && error.retryable && record.attempts < this.options.maxAttempts) {
      record.state = "pending";
      record.nextAttemptAt = new Date(Date.now() + this.backoffMs(record.attempts)).toISOString();
      this.save(record);
      return;
    }

    if (error.outcome === "not_sent") {
      record.state = "failed";
      delete record.nextAttemptAt;
      this.save(record);
      this.emitOutcome(record, "failed", category);
      return;
    }

    record.state = "unknown";
    delete record.nextAttemptAt;
    this.save(record);
    this.emitOutcome(record, "unknown", category);
  }

  private backoffMs(attempts: number): number {
    const delay = this.options.baseBackoffMs * 2 ** Math.max(0, attempts - 1);
    return Math.min(delay, this.options.maxBackoffMs);
  }

  private recoverInterruptedSending(): Set<string> {
    const recovered = new Set<string>();
    for (const record of this.readRecords()) {
      if (record.state === "pending") {
        this.emitOutcome(record, "pending");
        continue;
      }
      if (record.state !== "sending") {
        continue;
      }
      record.state = "unknown";
      record.updatedAt = new Date().toISOString();
      record.lastError = "interrupted_send";
      delete record.nextAttemptAt;
      this.save(record);
      recovered.add(record.id);
      this.emitOutcome(record, "unknown", record.lastError);
    }
    return recovered;
  }

  private reemitUnnotifiedTerminalOutcomes(skipIds: Set<string>): void {
    for (const record of this.readRecords()) {
      if (skipIds.has(record.id)) {
        continue;
      }
      if (record.outcomeNotifiedAt) {
        continue;
      }
      const outcome = terminalOutcomeFor(record);
      if (!outcome) {
        continue;
      }
      this.emitOutcome(record, outcome, record.lastError);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return this.activeDrain ?? Promise.resolve();
    }
    this.draining = true;
    this.activeDrain = this.performDrain();
    return this.activeDrain;
  }

  private async performDrain(): Promise<void> {
    try {
      for (const record of this.readRecords()) {
        if (!shouldAttempt(record)) {
          continue;
        }
        if (record.attempts >= this.options.maxAttempts) {
          record.state = "failed";
          record.updatedAt = new Date().toISOString();
          record.lastError = "attempts_exhausted";
          this.save(record);
          this.emitOutcome(record, "failed", record.lastError);
          continue;
        }
        try {
          await this.trackSend(this.sendMessageRecord(record));
        } catch (error) {
          const deliveryError = ensureDeliveryError(error);
          console.warn(`[outbound] Delivery ${record.state} for ${record.id}: ${failureCategory(deliveryError)}`);
        }
      }
    } finally {
      this.draining = false;
      this.activeDrain = null;
    }
  }

  private trackSend<T>(promise: Promise<T>): Promise<T> {
    this.activeSends.add(promise);
    promise.then(
      () => {
        this.activeSends.delete(promise);
      },
      () => {
        this.activeSends.delete(promise);
      },
    );
    return promise;
  }

  private async waitForActiveSends(): Promise<void> {
    while (this.activeSends.size > 0) {
      await Promise.allSettled([...this.activeSends]);
    }
  }

  private async waitForActiveCallbacks(): Promise<void> {
    while (this.activeCallbacks.size > 0) {
      await Promise.allSettled([...this.activeCallbacks]);
    }
  }

  private emitOutcome(record: OutboundRecord, state: OutcomeState, error?: string): void {
    if (!this.options.onOutcome) {
      return;
    }
    const event: OutboundOutcomeEvent = {
      workIds: [...record.workIds],
      state,
    };
    if (error) {
      event.error = error;
    }

    const notify = Promise.resolve()
      .then(() => this.options.onOutcome!(event))
      .then(() => {
        if (state !== "pending") {
          const latest = this.readRecord(record.id);
          if (latest && latest.state === state) {
            latest.outcomeNotifiedAt = new Date().toISOString();
            this.save(latest);
          }
        }
      })
      .catch(() => {
        console.warn(`[outbound] Outcome callback failed for ${record.id}`);
      });

    this.activeCallbacks.add(notify);
    notify.then(() => {
      this.activeCallbacks.delete(notify);
    });
  }

  private readRecord(id: string): OutboundRecord | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.pathFor(id), "utf-8"));
      if (isOutboundRecord(parsed, this.platform)) {
        return { ...parsed, kind: parsed.kind ?? "message" };
      }
    } catch {
      return null;
    }
    return null;
  }
}

export function withDurableOutbound(
  bridge: ChannelBridge,
  dataDir: string,
  options?: DurableOutboundOptions,
): ChannelBridge {
  return new DurableOutboundBridge(bridge, dataDir, options ?? {});
}
