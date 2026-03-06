/**
 * Restart protocol and config snapshot/rollback.
 *
 * Restart flow:
 *   1. Before restarting, snapshot the current (known-good) config.yml.
 *   2. Write a restart marker so the next boot knows who triggered the restart.
 *   3. Exit with RESTART_EXIT_CODE (42) to signal run.sh to loop immediately.
 *
 * On the next startup:
 *   - If loadConfig() succeeds, delete the snapshot (all good).
 *   - If loadConfig() fails and a snapshot exists, restore it and retry.
 *     This keeps the process alive even after a bad config edit.
 *
 * Exit code 42 tells the run.sh supervisor loop that the exit was intentional
 * so it restarts immediately without the normal delay.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Exit code that signals an intentional restart to the run.sh supervisor.
 * The loop checks for this code and restarts immediately without delay.
 */
export const RESTART_EXIT_CODE = 42;

// ---------------------------------------------------------------------------
// Restart marker
// ---------------------------------------------------------------------------

export interface RestartMarker {
  userId: string;
  channelId: string;
  platform: string;
  reason: string;
}

function restartMarkerPath(dataDir: string): string {
  return path.join(dataDir, "pending", "restart.json");
}

export function writeRestartMarker(dataDir: string, marker: RestartMarker): void {
  fs.mkdirSync(path.join(dataDir, "pending"), { recursive: true });
  fs.writeFileSync(restartMarkerPath(dataDir), JSON.stringify(marker), "utf8");
}

export interface RestartMarkerResult {
  marker: RestartMarker;
  /** True if config.yml was corrupted and auto-rolled back to the pre-restart snapshot. */
  configRolledBack: boolean;
  /** The parse/validation error message if a rollback occurred. */
  rollbackReason?: string;
}

export function readAndClearRestartMarker(dataDir: string): RestartMarkerResult | null {
  const p = restartMarkerPath(dataDir);
  if (!fs.existsSync(p)) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(p, "utf8")) as RestartMarker;
    fs.rmSync(p, { force: true });
    return { marker, configRolledBack: false };
  } catch {
    fs.rmSync(p, { force: true });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config snapshot / rollback
// ---------------------------------------------------------------------------

function configSnapshotPath(dataDir: string): string {
  return path.join(dataDir, "pending", "config.yml.pre-restart");
}

/**
 * Snapshot the current config.yml before triggering a restart.
 * Called only when config.yml exists (successful boot confirms it was valid).
 */
export function snapshotConfig(dataDir: string): void {
  const dataDir_ = path.resolve(process.env.BRYTI_DATA_DIR || "./data");
  // Use the resolved data dir from env, not the one stored in config (same value, but safer).
  const src = path.join(dataDir_, "config.yml");
  const dst = configSnapshotPath(dataDir_);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    console.log("[config] Snapshotted config.yml for rollback if restart fails.");
  }
}

/**
 * On startup: if loadConfig() throws and a snapshot exists, restore it and
 * return the error that triggered the rollback. Otherwise rethrow.
 *
 * Returns the loaded config (from snapshot or original).
 * Throws only if loadConfig() fails AND no snapshot is available.
 */
export function loadConfigWithRollback(): { config: ReturnType<typeof loadConfig>; rolledBack: boolean; rollbackReason?: string } {
  const dataDir = path.resolve(process.env.BRYTI_DATA_DIR || "./data");
  try {
    const config = loadConfig();
    // Success: delete any leftover snapshot (previous good restart).
    const snap = configSnapshotPath(dataDir);
    if (fs.existsSync(snap)) {
      fs.rmSync(snap, { force: true });
      console.log("[config] Deleted config snapshot (current config loaded successfully).");
    }
    return { config, rolledBack: false };
  } catch (err) {
    const snap = configSnapshotPath(dataDir);
    if (!fs.existsSync(snap)) {
      // No snapshot to fall back on — propagate the error.
      throw err;
    }

    const reason = (err as Error).message;
    console.warn(`[config] loadConfig() failed: ${reason}`);
    console.warn("[config] Restoring config.yml from pre-restart snapshot...");

    const cfgPath = path.join(dataDir, "config.yml");
    fs.copyFileSync(snap, cfgPath);
    fs.rmSync(snap, { force: true });

    // Retry with the restored config — if this also fails, propagate.
    const config = loadConfig();
    console.warn("[config] Rollback successful. Running on previous config.");
    return { config, rolledBack: true, rollbackReason: reason };
  }
}
