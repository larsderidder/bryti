/**
 * Per-channel FIFO message queue with merge and backpressure.
 *
 * Behaviour:
 * - Messages are processed one at a time per channel.
 * - While processing, new messages are queued (up to MAX_DEPTH).
 * - If the queue is full, the caller receives a rejection callback so it can
 *   notify the user.
 * - Messages that arrive within MERGE_WINDOW_MS of each other while the queue
 *   is idle-but-draining are merged into a single prompt, separated by newlines.
 *   This handles the common "user sends three quick messages" pattern.
 */

import type { IncomingMessage } from "./channels/types.js";

const MAX_DEPTH = 10;
const MERGE_WINDOW_MS = 5000;

interface QueueEntry {
  msg: IncomingMessage;
  arrivedAt: number;
}

type ProcessFn = (msg: IncomingMessage) => Promise<void>;
type RejectFn = (msg: IncomingMessage) => Promise<void>;

interface ChannelQueue {
  entries: QueueEntry[];
  processing: boolean;
}

/**
 * A message queue that serialises processing per channel and merges rapid
 * follow-up messages into a single prompt.
 */
export class MessageQueue {
  private readonly queues = new Map<string, ChannelQueue>();
  private readonly processFn: ProcessFn;
  private readonly rejectFn: RejectFn;
  private readonly maxDepth: number;
  private readonly mergeWindowMs: number;

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
  }

  /**
   * Enqueue a message. If nothing is processing for this channel, starts
   * draining immediately.
   */
  enqueue(msg: IncomingMessage): void {
    const key = msg.channelId;
    let q = this.queues.get(key);
    if (!q) {
      q = { entries: [], processing: false };
      this.queues.set(key, q);
    }

    if (q.entries.length >= this.maxDepth) {
      // Queue full: reject without queuing
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
   * arrived within mergeWindowMs of the first entry in the batch.
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
   * their text with newlines. Metadata is taken from the first entry.
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

  /** Number of queued (not-yet-processing) messages for a channel. */
  queueDepth(channelId: string): number {
    return this.queues.get(channelId)?.entries.length ?? 0;
  }

  /** Whether a channel is currently processing a message. */
  isProcessing(channelId: string): boolean {
    return this.queues.get(channelId)?.processing ?? false;
  }
}
