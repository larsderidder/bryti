/**
 * Events watcher.
 *
 * Watches data/events/ for JSON files dropped by external processes (pi
 * sessions, scripts, webhooks via skills). Each file is a notification
 * request that gets translated into a synthetic IncomingMessage and enqueued
 * for the target user.
 *
 * Discovery: on start() bryti writes ~/.pi/agent/bryti-instance.json with the
 * events directory path and allowed user IDs. The bryti-bridge extension in pi
 * reads this file to find the events directory without needing an env var.
 * The file is removed on stop().
 *
 * File format:
 *   { "userId": "123456789", "text": "...", "source": "pi-session" }
 *
 * On receipt the file is deleted. Invalid files are also deleted (with a
 * warning) so they don't accumulate. The watcher is best-effort: if a file
 * lands while bryti is down it will be processed on the next startup scan.
 *
 * Security: userId is validated against the allowed-users list from config.
 * Files with unknown userIds are rejected and deleted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.js";
import type { IncomingMessage } from "./channels/types.js";

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
}

type EnqueueFn = (msg: IncomingMessage) => void;

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
    fs.mkdirSync(path.join(os.homedir(), ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      instanceFilePath(),
      JSON.stringify({ eventsDir: evDir, allowedUsers: [...allowed] }, null, 2),
      "utf-8",
    );
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
  const ids = new Set<string>();
  for (const id of config.telegram.allowed_users) {
    ids.add(String(id));
  }
  if (config.whatsapp.enabled) {
    for (const id of config.whatsapp.allowed_users) {
      ids.add(String(id));
    }
  }
  return ids;
}

/**
 * Parse, validate, and process a single event file.
 * Deletes the file after processing (success or failure).
 */
function processEventFile(
  filePath: string,
  allowed: Set<string>,
  enqueue: EnqueueFn,
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
  console.log(`[events] Received from ${source} for user ${event.userId}: ${event.text.slice(0, 80)}${event.text.length > 80 ? "…" : ""}`);

  // Delete first so a crash during enqueue doesn't cause a double-fire on restart.
  tryDelete(filePath);

  const msg: IncomingMessage = {
    channelId: event.userId,
    userId: event.userId,
    text: event.text,
    platform: "telegram",
    raw: { type: "event", source },
  };

  enqueue(msg);
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

  function scanExisting(): void {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const file of files) {
      processEventFile(path.join(dir, file), allowed, enqueue);
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
      fs.mkdirSync(dir, { recursive: true });

      // Write presence file so pi extensions can discover the events directory.
      writeInstanceFile(dir, allowed);

      // Process any events that landed while bryti was down.
      scanExisting();

      watcher = fs.watch(dir, { persistent: false }, onFsEvent);
      watcher.on("error", (err) => {
        console.error(`[events] Watcher error: ${err.message}`);
      });
      console.log(`[events] Watching ${dir}`);
    },

    stop(): void {
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
