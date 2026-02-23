/**
 * Per-channel FIFO message queue with merge and backpressure.
 *
 * Two core guarantees:
 *
 * 1. Per-channel serialization: only one message is processed at a time per
 *    channel. Subsequent messages queue up behind it rather than racing into
 *    the agent loop in parallel.
 *
 * 2. Burst merging: rapid-fire messages that arrive within MERGE_WINDOW_MS of
 *    each other are joined into a single prompt before being dispatched. This
 *    handles the common "user sends three quick messages" pattern without the
 *    agent seeing three separate incomplete thoughts.
 *
 * New messages queue up to MAX_DEPTH; beyond that the caller gets a rejection
 * callback (backpressure signal, not silent drop).
 */

import type { IncomingMessage } from "./channels/types.js";

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
 * Serialises processing per channel and merges rapid follow-up messages.
 */
export class MessageQueue {
  private readonly queues = new Map<string, ChannelQueue>();
  private readonly processFn: ProcessFn;
  private readonly rejectFn: RejectFn;
  private readonly maxDepth: number;
  private readonly mergeWindowMs: number;
  private readonly rateLimiter: RateLimiter;

  constructor(
    processFn: ProcessFn,
    rejectFn: RejectFn,
    maxDepth = MAX_DEPTH,
    mergeWindowMs = MERGE_WINDOW_MS,
  ) {
    this.processFn = processFn;
    this.rejectFn = rejectFn;
    this.maxDepth = maxDepth;
    this.mergeWindowMs = mergeWindowMs;
    this.rateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  }

  /**
   * Enqueue a message. If nothing is processing for this channel, starts
   * draining immediately. Rate-limited per user (10 messages/minute).
   */
  enqueue(msg: IncomingMessage): void {
    const key = msg.channelId;

    // Rate limiting: skip for internal messages (worker triggers, scheduler)
    const rawObj = msg.raw as Record<string, unknown> | null | undefined;
    const isInternal = rawObj?.type != null;
    if (!isInternal && !this.rateLimiter.check(msg.userId)) {
      console.warn(`[queue] Rate limit exceeded for user ${msg.userId}`);
      this.rejectFn(msg).catch((err) => console.error("rejectFn error:", err));
      return;
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
      return;
    }

    q.entries.push({ msg, arrivedAt: Date.now() });

    if (!q.processing) {
      this.drain(key).catch((err) => console.error("Queue drain error:", err));
    }
  }

  /**
   * Drain the queue for a channel sequentially, merging close messages.
   */
  private async drain(key: string): Promise<void> {
    const q = this.queues.get(key);
    if (!q) return;

    q.processing = true;

    while (q.entries.length > 0) {
      const batch = this.takeMergeBatch(q);
      const merged = this.mergeEntries(batch);
      try {
        await this.processFn(merged);
      } catch (err) {
        console.error("processMessage error:", err);
      }
    }

    q.processing = false;
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
      if (next.arrivedAt - first.arrivedAt <= this.mergeWindowMs) {
        batch.push(q.entries.shift()!);
      } else {
        break;
      }
    }

    return batch;
  }

  /**
   * Merge multiple queue entries into a single IncomingMessage by joining
   * their text with newlines. Metadata (userId, channelId, platform, etc.) is
   * taken from the first entry.
   *
   * Note: images (and other non-text attachments) from subsequent burst
   * entries are currently dropped — only their text is merged.
   * TODO: carry images from all burst entries into the merged message.
   */
  private mergeEntries(entries: QueueEntry[]): IncomingMessage {
    if (entries.length === 1) {
      return entries[0].msg;
    }

    const texts = entries.map((e) => e.msg.text).filter(Boolean);
    return {
      ...entries[0].msg,
      text: texts.join("\n"),
    };
  }

  /**
   * Number of queued (not-yet-processing) messages for a channel.
   * Exposed for monitoring dashboards and unit tests.
   */
  queueDepth(channelId: string): number {
    return this.queues.get(channelId)?.entries.length ?? 0;
  }

  /**
   * Whether the channel is currently mid-process (drain loop running).
   * Exposed for monitoring dashboards and unit tests.
   */
  isProcessing(channelId: string): boolean {
    return this.queues.get(channelId)?.processing ?? false;
  }
}
