/**
 * Crash recovery: pending-message checkpoints.
 *
 * Before processing a user message, write a checkpoint to disk. If the process
 * crashes mid-response, the next startup finds the checkpoint and notifies the
 * user. Checkpoints are deleted after successful processing.
 */

import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { IncomingMessage } from "./channels/types.js";

export interface PendingCheckpoint {
  text: string;
  channelId: string;
  platform: string;
  timestamp: number;
}

function pendingDir(config: Config): string {
  return path.join(config.data_dir, "pending");
}

function pendingPath(config: Config, userId: string): string {
  return path.join(pendingDir(config), `${userId}.json`);
}

export function writePendingCheckpoint(config: Config, msg: IncomingMessage): void {
  const checkpoint: PendingCheckpoint = {
    text: msg.text,
    channelId: msg.channelId,
    platform: msg.platform,
    timestamp: Date.now(),
  };
  try {
    fs.writeFileSync(pendingPath(config, msg.userId), JSON.stringify(checkpoint), "utf8");
  } catch (err) {
    console.warn("[pending] Failed to write checkpoint:", (err as Error).message);
  }
}

export function deletePendingCheckpoint(config: Config, userId: string): void {
  try {
    fs.rmSync(pendingPath(config, userId), { force: true });
  } catch (err) {
    console.warn("[pending] Failed to delete checkpoint:", (err as Error).message);
  }
}

/**
 * Scan for leftover pending files from a previous crash. Files between
 * 2 min and 1 hour old get a notification; older ones are silently discarded.
 */
export async function recoverPendingCheckpoints(
  config: Config,
  sendNotification: (checkpoint: PendingCheckpoint, userId: string) => Promise<void>,
): Promise<void> {
  const dir = pendingDir(config);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "restart.json");
  } catch {
    return;
  }

  if (entries.length === 0) return;

  const now = Date.now();
  const MIN_AGE_MS = 2 * 60 * 1000;   // 2 minutes: ignore files written moments before a clean restart
  const MAX_AGE_MS = 60 * 60 * 1000;  // 1 hour: too stale to be useful

  // Group by userId (filename = <userId>.json), keep most recent per user
  const byUser = new Map<string, { checkpoint: PendingCheckpoint; filePath: string }>();

  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    let checkpoint: PendingCheckpoint;
    try {
      checkpoint = JSON.parse(fs.readFileSync(filePath, "utf8")) as PendingCheckpoint;
    } catch {
      fs.rmSync(filePath, { force: true });
      continue;
    }

    const userId = entry.slice(0, -5); // strip .json
    const existing = byUser.get(userId);
    if (!existing || checkpoint.timestamp > existing.checkpoint.timestamp) {
      byUser.set(userId, { checkpoint, filePath });
    }
  }

  for (const [userId, { checkpoint, filePath }] of byUser) {
    const age = now - checkpoint.timestamp;

    // Always delete the file first to prevent repeat notifications on the next restart
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // ignore
    }

    if (age < MIN_AGE_MS || age > MAX_AGE_MS) {
      console.log(`[pending] Skipping stale checkpoint for ${userId} (age ${Math.round(age / 1000)}s)`);
      continue;
    }

    console.log(`[pending] Crash recovery: notifying ${userId} (age ${Math.round(age / 1000)}s)`);
    try {
      await sendNotification(checkpoint, userId);
    } catch (err) {
      console.warn(`[pending] Failed to notify ${userId}:`, (err as Error).message);
    }
  }
}
