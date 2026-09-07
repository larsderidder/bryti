/**
 * Events watcher.
 *
 * Watches data/events/ for JSON files dropped by external processes (pi
 * sessions, scripts, webhooks via skills). Each file is a notification
 * request that gets translated into a synthetic IncomingMessage and enqueued
 * for the target user.
 *
 * Discovery: on start() bryti writes ~/.pi/agent/bryti-instance.json with the
 * events directory path and allowed user IDs. The pi-bridge extension in pi
 * reads this file to find the events directory without needing an env var.
 * The file is removed on stop().
 *
 * File format:
 *   { "userId": "123456789", "text": "...", "source": "pi-session" }
 *
 * Files are deleted after durable queue acceptance. Rejected work stays on disk
 * for a later scan. Invalid requests are deleted with a warning.
 *
 * Security: userId is validated against the allowed-users list from config.
 * Files with unknown userIds are rejected and deleted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.js";
import type { IncomingMessage } from "./channels/types.js";
import crypto from "node:crypto";
import { getSchedulerTargets } from "./scheduler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventFile {
  /** Target user ID (Telegram or WhatsApp). Must be in allowed_users. */
  userId: string;
  /** Message text to inject into the agent loop for this user. */
  text: string;
  /** Optional: identifies who sent the event (for logging). */
  source?: string;
  platform?: IncomingMessage["platform"];
  channelId?: string;
  threadId?: string;
  channelThreadId?: string;
}

type EnqueueFn = (msg: IncomingMessage) => boolean | void;

export interface EventsWatcher {
  start(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventsDir(dataDir: string): string {
  return path.join(dataDir, "events");
}

/**
 * Path to the presence file that tells pi extensions where bryti is running.
 * Placed in the global pi agent dir so all pi sessions can find it.
 */
function instanceFilePath(): string {
  return path.join(os.homedir(), ".pi", "agent", "bryti-instance.json");
}

/**
 * Write a presence file so the bryti-bridge extension knows the events dir.
 * Contains the absolute path to the events directory and allowed user IDs.
 */
function writeInstanceFile(evDir: string, allowed: Set<string>): void {
  try {
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(agentDir, 0o700); } catch { /* best effort */ }
    fs.writeFileSync(
      instanceFilePath(),
      JSON.stringify({ eventsDir: evDir, allowedUsers: [...allowed] }, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
    try { fs.chmodSync(instanceFilePath(), 0o600); } catch { /* best effort */ }
  } catch (err) {
    console.warn(`[events] Could not write instance file: ${(err as Error).message}`);
  }
}

function removeInstanceFile(): void {
  try {
    fs.unlinkSync(instanceFilePath());
  } catch {
    // Already gone — fine.
  }
}

function allowedUsers(config: Config): Set<string> {
  return new Set(getSchedulerTargets(config).map((target) => target.userId));
}

/**
 * Parse, validate, and process a single event file.
 * Deletes accepted or invalid files; retains work when acceptance fails.
 */
function processEventFile(
  filePath: string,
  allowed: Set<string>,
  enqueue: EnqueueFn,
  config: Config,
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    // File disappeared between detection and read — that's fine.
    return;
  }

  let event: EventFile;
  try {
    event = JSON.parse(raw) as EventFile;
  } catch {
    console.warn(`[events] Ignoring unparseable event file: ${path.basename(filePath)}`);
    tryDelete(filePath);
    return;
  }

  // Validate
  if (!event.userId || typeof event.userId !== "string") {
    console.warn(`[events] Event file missing userId: ${path.basename(filePath)}`);
    tryDelete(filePath);
    return;
  }
  if (!event.text || typeof event.text !== "string") {
    console.warn(`[events] Event file missing text: ${path.basename(filePath)}`);
    tryDelete(filePath);
    return;
  }
  if (!allowed.has(event.userId)) {
    console.warn(`[events] Rejecting event for unknown userId ${event.userId}: ${path.basename(filePath)}`);
    tryDelete(filePath);
    return;
  }

  const source = event.source ?? "external";
  const targets = getSchedulerTargets(config).filter((target) => {
    return target.userId === event.userId
      && target.channelId === (event.channelId ?? event.userId)
      && (!event.platform || target.platform === event.platform);
  });
  if (targets.length !== 1) {
    console.warn(`[events] Event destination is unavailable or ambiguous: ${path.basename(filePath)}`);
    tryDelete(filePath);
    return;
  }
  const target = targets[0];
  console.log(`[events] Received notification for ${target.platform}:${event.userId}`);

  const msg: IncomingMessage = {
    ...target,
    threadId: event.threadId,
    channelThreadId: event.channelThreadId,
    text: event.text,
    workId: `event:${crypto.createHash("sha256").update(path.basename(filePath)).update(raw).digest("hex")}`,
    raw: { type: "event", source },
  };

  try {
    if (enqueue(msg) !== false) {
      tryDelete(filePath);
    }
  } catch {
    console.warn(`[events] Acceptance failed; retaining ${path.basename(filePath)}`);
  }
}

function tryDelete(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already gone — fine.
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and return an events watcher.
 *
 * Call start() to begin watching. Call stop() to clean up.
 */
export function createEventsWatcher(config: Config, enqueue: EnqueueFn): EventsWatcher {
  const dir = eventsDir(config.data_dir);
  const allowed = allowedUsers(config);
  let watcher: fs.FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setInterval> | null = null;

  function scanExisting(): void {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const file of files) {
      processEventFile(path.join(dir, file), allowed, enqueue, config);
    }
  }

  function onFsEvent(_event: string, filename: string | null): void {
    if (!filename || !filename.endsWith(".json")) return;

    // Debounce: rapid successive writes (e.g., temp file then rename) produce
    // multiple events. Wait 100ms and then do a full directory scan instead of
    // tracking individual filenames. Simple and avoids missed events.
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      scanExisting();
    }, 100);
  }

  return {
    start(): void {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }

      // Write presence file so pi extensions can discover the events directory.
      writeInstanceFile(dir, allowed);

      // Process any events that landed while bryti was down.
      scanExisting();

      watcher = fs.watch(dir, { persistent: false }, onFsEvent);
      retryTimer = setInterval(scanExisting, 30_000);
      retryTimer.unref();
      watcher.on("error", (err) => {
        console.error(`[events] Watcher error: ${err.message}`);
      });
      console.log(`[events] Watching ${dir}`);
    },

    stop(): void {
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
      if (debounce) {
        clearTimeout(debounce);
        debounce = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      removeInstanceFile();
    },
  };
}
