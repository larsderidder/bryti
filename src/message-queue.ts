/**
 * Per-session FIFO message queue with merge and backpressure.
 *
 * Two core guarantees:
 *
 * 1. Per-session serialization: user messages and internal notifications for
 *    the same agent session share one queue, even across different channels.
 *
 * 2. Burst merging: rapid-fire messages that arrive within MERGE_WINDOW_MS of
 *    each other are joined into a single prompt before being dispatched. This
 *    handles the common "user sends three quick messages" pattern without the
 *    agent seeing three separate incomplete thoughts.
 *
 * New messages queue up to MAX_DEPTH; beyond that the caller gets a rejection
 * callback (backpressure signal, not silent drop).
 */

import { isInternalMessage, type IncomingMessage } from "./channels/types.js";
import { DEFAULT_THREAD_ID, getSessionKey } from "./threads.js";
import type { WorkStore } from "./work/store.js";

const MAX_DEPTH = 10;
// 2-3 seconds is the sweet spot: fast enough that the user experiences a
// single response (not noticeable delay), long enough to catch split messages
// that arrive in separate network frames. The current 5s value is conservative
// and can be tuned down if latency matters more.
const MERGE_WINDOW_MS = 5000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface QueueEntry {
  msg: IncomingMessage;
  /** Wall-clock arrival time (Date.now()). Used for merge window calculation,
   *  not as a processing-start marker — the message may sit in the queue for
   *  some time before draining begins. */
  arrivedAt: number;
}

type ProcessFn = (msg: IncomingMessage) => Promise<void>;
type RejectFn = (msg: IncomingMessage) => Promise<void>;

interface ChannelQueue {
  entries: QueueEntry[];
  processing: boolean;
}

/** Only merge user messages with the same reply destination. */
function canMerge(first: IncomingMessage, next: IncomingMessage): boolean {
  return !isInternalMessage(first) && !isInternalMessage(next)
    && !first.text.startsWith("/") && !next.text.startsWith("/")
    && first.channelId === next.channelId
    && first.platform === next.platform
    && first.channelThreadId === next.channelThreadId;
}

/**
 * Sliding window rate limiter. Tracks timestamps of recent messages per user
 * and rejects when the limit is exceeded.
 */
class RateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly maxMessages: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Check if a message from this user should be allowed.
   * Returns true if allowed, false if rate-limited.
   */
  check(userId: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.windows.get(userId);

    if (!timestamps) {
      timestamps = [];
      this.windows.set(userId, timestamps);
    }

    // Prune old entries
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxMessages) {
      return false;
    }

    timestamps.push(now);
    return true;
  }
}

/**
 * Serializes processing per agent session and merges rapid user messages.
 */
export class MessageQueue {
  private readonly queues = new Map<string, ChannelQueue>();
  private readonly processFn: ProcessFn;
  private readonly rejectFn: RejectFn;
  private readonly maxDepth: number;
  private readonly mergeWindowMs: number;
  private readonly rateLimiter: RateLimiter;
  private paused: boolean;
  private accepting = true;
  private readonly queuedIds = new Set<string>();
  private readonly drains = new Set<Promise<void>>();

  constructor(
    processFn: ProcessFn,
    rejectFn: RejectFn,
    maxDepth = MAX_DEPTH,
    mergeWindowMs = MERGE_WINDOW_MS,
    private readonly activeThread: (userId: string) => string = () => DEFAULT_THREAD_ID,
    private readonly durability: { store?: WorkStore; paused?: boolean } = {},
  ) {
    this.processFn = processFn;
    this.rejectFn = rejectFn;
    this.maxDepth = maxDepth;
    this.mergeWindowMs = mergeWindowMs;
    this.rateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
    this.paused = durability.paused ?? false;
  }

  /**
   * Enqueue a message, resolving its thread before choosing the session queue.
   * Drains immediately when idle. Rate-limited per user (10 messages/minute).
   */
  enqueue(msg: IncomingMessage): boolean {
    if (!this.accepting) {
      return false;
    }
    const threadId = msg.threadId ?? this.activeThread(msg.userId);
    msg = { ...msg, threadId };
    const key = getSessionKey(msg.userId, threadId);

    // Rate limiting: skip for internal messages (worker triggers, scheduler)
    const isInternal = isInternalMessage(msg);
    if (!isInternal && !this.rateLimiter.check(msg.userId)) {
      console.warn(`[queue] Rate limit exceeded for user ${msg.userId}`);
      this.rejectFn(msg).catch((err) => console.error("rejectFn error:", err));
      return false;
    }

    let q = this.queues.get(key);
    if (!q) {
      q = { entries: [], processing: false };
      this.queues.set(key, q);
    }

    if (q.entries.length >= this.maxDepth) {
      // Queue full: invoke the rejection callback immediately and return without
      // enqueuing. This is a backpressure signal to the caller — the message is
      // not silently dropped, but it is not queued either. The caller decides
      // how to respond (e.g., send "I'm busy" to the user).
      this.rejectFn(msg).catch((err) => console.error("rejectFn error:", err));
      return false;
    }

    if (this.durability.store) {
      const accepted = this.durability.store.accept(msg);
      if (!accepted.created) {
        return true;
      }
      msg = accepted.record.message;
      this.queuedIds.add(accepted.record.id);
    }
    q.entries.push({ msg, arrivedAt: Date.now() });
    this.scheduleDrain(key);
    return true;
  }

  /** Restore accepted input after the caller reconciles interrupted work. */
  start(): void {
    if (this.durability.store) {
      // Rebuild from acceptance order, including messages admitted during startup.
      for (const queue of this.queues.values()) {
        queue.entries = [];
      }
      this.queuedIds.clear();
    }
    for (const record of this.durability.store?.queued() ?? []) {
      if (this.queuedIds.has(record.id)) {
        continue;
      }
      const msg = record.message;
      const key = getSessionKey(msg.userId, msg.threadId ?? DEFAULT_THREAD_ID);
      let queue = this.queues.get(key);
      if (!queue) {
        queue = { entries: [], processing: false };
        this.queues.set(key, queue);
      }
      queue.entries.push({ msg, arrivedAt: Date.parse(record.createdAt) });
      this.queuedIds.add(record.id);
    }
    this.paused = false;
    for (const key of this.queues.keys()) {
      this.scheduleDrain(key);
    }
  }

  /** Stop admission and leave not-yet-started work persisted for recovery. */
  stop(): void {
    this.accepting = false;
    this.paused = true;
  }

  async waitForIdle(): Promise<void> {
    while (this.drains.size > 0) {
      await Promise.all([...this.drains]);
    }
  }

  private scheduleDrain(key: string): void {
    if (this.paused || this.queues.get(key)?.processing) {
      return;
    }
    const drain = this.drain(key).catch((err) => console.error("Queue drain error:", err));
    this.drains.add(drain);
    void drain.finally(() => this.drains.delete(drain));
  }

  /**
   * Drain the queue for a session sequentially, merging compatible messages.
   */
  private async drain(key: string): Promise<void> {
    const q = this.queues.get(key);
    if (!q) return;

    q.processing = true;

    try {
      while (!this.paused && q.entries.length > 0) {
        const batch = this.takeMergeBatch(q);
        const merged = this.mergeEntries(batch);
        const ids = merged.workIds ?? [];
        if (this.durability.store && !this.durability.store.claim(ids)) {
          const waiting = batch.filter((entry) => {
            return entry.msg.workIds?.every((id) => this.durability.store!.get(id)?.execution === "queued");
          });
          q.entries.unshift(...waiting);
          for (const id of ids) {
            if (this.durability.store.get(id)?.execution !== "queued") {
              this.queuedIds.delete(id);
            }
          }
          console.warn(`[queue] Batch already claimed; retained ${waiting.length} queued entries`);
          continue;
        }
        try {
          await this.processFn(merged);
          this.durability.store?.finish(ids, "completed");
        } catch (err) {
          this.durability.store?.finish(ids, "failed", "Message processing failed");
          console.error("processMessage error:", err);
        } finally {
          for (const id of ids) {
            this.queuedIds.delete(id);
          }
        }
      }
    } finally {
      q.processing = false;
    }
  }

  /**
   * Take a batch of entries that should be merged together.
   *
   * The first entry is always included. Additional entries are included if they
   * arrived within mergeWindowMs of the FIRST entry in the batch. This is a
   * fixed window anchored to the first message, not a sliding window — an
   * entry that arrives 1ms after the previous one is still excluded if it
   * falls outside the window from the first entry.
   */
  private takeMergeBatch(q: ChannelQueue): QueueEntry[] {
    const batch: QueueEntry[] = [];
    const first = q.entries.shift()!;
    batch.push(first);

    while (q.entries.length > 0) {
      const next = q.entries[0];
      if (next.arrivedAt - first.arrivedAt <= this.mergeWindowMs && canMerge(first.msg, next.msg)) {
        batch.push(q.entries.shift()!);
      } else {
        break;
      }
    }

    return batch;
  }

  /**
   * Merge multiple queue entries into a single IncomingMessage by joining
   * their text with newlines and concatenating attachment arrays from all
   * entries. Metadata (userId, channelId, platform, etc.) is taken from the
   * first entry.
   */
  private mergeEntries(entries: QueueEntry[]): IncomingMessage {
    if (entries.length === 1) {
      return entries[0].msg;
    }

    const texts = entries.map((e) => e.msg.text).filter(Boolean);

    // Collect attachments from every entry so media followed by a caption (or
    // vice versa) within the merge window is not silently dropped.
    const allImages = entries.flatMap((e) => e.msg.images ?? []);
    const allAudio = entries.flatMap((e) => e.msg.audio ?? []);
    const replyMode = entries.some((e) => e.msg.replyMode === "voice") ? "voice" : entries[0].msg.replyMode;

    return {
      ...entries[0].msg,
      text: texts.join("\n"),
      workIds: entries.flatMap((entry) => entry.msg.workIds ?? []),
      ...(allImages.length > 0 ? { images: allImages } : {}),
      ...(allAudio.length > 0 ? { audio: allAudio } : {}),
      ...(replyMode ? { replyMode } : {}),
    };
  }

  /**
   * Number of queued (not-yet-processing) messages for a session key.
   * Exposed for monitoring dashboards and unit tests.
   */
  queueDepth(sessionKey: string): number {
    return this.queues.get(sessionKey)?.entries.length ?? 0;
  }

  /**
   * Whether the session is currently mid-process (drain loop running).
   * Exposed for monitoring dashboards and unit tests.
   */
  isProcessing(sessionKey: string): boolean {
    return this.queues.get(sessionKey)?.processing ?? false;
  }
}
