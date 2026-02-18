/**
 * Unified scheduler.
 *
 * Manages two kinds of scheduled jobs:
 * - Config-driven: defined in config.yml under `cron`, operator-controlled.
 * - Agent-managed: created/deleted at runtime by the agent via schedule tools,
 *   persisted to `data/schedules.json`.
 *
 * Both kinds inject synthetic IncomingMessages into the agent loop, routed to
 * the first allowed Telegram user's channel.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { Config } from "./config.js";
import type { IncomingMessage } from "./channels/types.js";

// ---------------------------------------------------------------------------
// Schedule record (agent-managed)
// ---------------------------------------------------------------------------

export interface ScheduleRecord {
  id: string;
  schedule: string;
  message: string;
  description: string;
  userId: string;
  channelId: string;
  created_at: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Scheduler interface
// ---------------------------------------------------------------------------

export interface Scheduler {
  /** Start all jobs (config-driven and agent-managed from disk). */
  start(): void;

  /** Stop all running jobs. */
  stop(): void;

  /** Create a new agent-managed schedule. Returns the created record. */
  create(params: {
    schedule: string;
    message: string;
    description: string;
    userId: string;
    channelId: string;
  }): ScheduleRecord;

  /** List all agent-managed schedules. */
  list(): ScheduleRecord[];

  /** Delete an agent-managed schedule by id. Returns true if found and removed. */
  delete(id: string): boolean;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function schedulesFilePath(dataDir: string): string {
  return path.join(dataDir, "schedules.json");
}

function loadSchedules(dataDir: string): ScheduleRecord[] {
  const filePath = schedulesFilePath(dataDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ScheduleRecord[];
  } catch {
    console.error("[scheduler] Failed to parse schedules.json, starting fresh");
    return [];
  }
}

function saveSchedules(dataDir: string, records: ScheduleRecord[]): void {
  const filePath = schedulesFilePath(dataDir);
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the unified scheduler.
 *
 * @param config      App config (for config.yml cron jobs and the default channel).
 * @param onMessage   Callback to inject synthetic messages into the agent loop.
 */
export function createScheduler(
  config: Config,
  onMessage: (msg: IncomingMessage) => Promise<void>,
): Scheduler {
  // Live croner jobs keyed by schedule id (agent-managed) or index (config)
  const cronJobs = new Map<string, Cron>();

  // In-memory records (agent-managed only; config jobs are ephemeral)
  let agentRecords: ScheduleRecord[] = [];

  // Default channel: first allowed Telegram user, or "cron" as fallback
  function defaultChannelId(): string {
    const firstUser = config.telegram.allowed_users[0];
    return firstUser ? String(firstUser) : "cron";
  }

  function startConfigJobs(): void {
    for (let i = 0; i < config.cron.length; i++) {
      const cronJob = config.cron[i];
      const key = `config-${i}`;
      try {
        const job = new Cron(
          cronJob.schedule,
          async () => {
            console.log(`[scheduler] Config job triggered: ${cronJob.schedule}`);
            const channelId = defaultChannelId();
            const msg: IncomingMessage = {
              channelId,
              userId: "cron",
              text: cronJob.message,
              platform: "telegram",
              raw: { type: "cron", schedule: cronJob.schedule },
            };
            await onMessage(msg);
          },
          { timezone: "UTC" },
        );
        cronJobs.set(key, job);
        console.log(
          `[scheduler] Config job scheduled: ${cronJob.schedule} -> ` +
          `${cronJob.message.substring(0, 50)}...`,
        );
      } catch (err) {
        console.error(`[scheduler] Failed to schedule config job: ${cronJob.schedule}`, err);
      }
    }
  }

  /**
   * Start a croner job for the given agent-managed record.
   *
   * Throws if the cron expression is invalid (croner throws synchronously).
   * Callers that want fault-tolerance should catch the error themselves.
   */
  function startAgentJob(record: ScheduleRecord): void {
    if (!record.enabled) return;
    const job = new Cron(
      record.schedule,
      async () => {
        console.log(`[scheduler] Agent job triggered: ${record.id} (${record.description})`);
        const msg: IncomingMessage = {
          channelId: record.channelId,
          userId: record.userId,
          text: record.message,
          platform: "telegram",
          raw: { type: "schedule", scheduleId: record.id },
        };
        await onMessage(msg);
      },
      { timezone: "UTC" },
    );
    cronJobs.set(record.id, job);
  }

  function stopJob(key: string): void {
    const job = cronJobs.get(key);
    if (job) {
      job.stop();
      cronJobs.delete(key);
    }
  }

  return {
    start(): void {
      agentRecords = loadSchedules(config.data_dir);

      startConfigJobs();

      for (const record of agentRecords) {
        try {
          startAgentJob(record);
        } catch (err) {
          console.error(
            `[scheduler] Failed to start agent job ${record.id}: ${record.schedule}`,
            err,
          );
        }
      }

      const total = cronJobs.size;
      if (total > 0) {
        console.log(
          `[scheduler] Started ${total} jobs ` +
          `(${config.cron.length} config, ${agentRecords.filter((r) => r.enabled).length} agent-managed)`,
        );
      }
    },

    stop(): void {
      for (const [key, job] of cronJobs) {
        job.stop();
        cronJobs.delete(key);
      }
      console.log("[scheduler] All jobs stopped");
    },

    create(params): ScheduleRecord {
      const record: ScheduleRecord = {
        id: randomUUID(),
        schedule: params.schedule,
        message: params.message,
        description: params.description,
        userId: params.userId,
        channelId: params.channelId,
        created_at: new Date().toISOString(),
        enabled: true,
      };

      // Start first: throws immediately on invalid cron expression.
      // Only persist to disk if the expression is valid.
      startAgentJob(record);

      agentRecords.push(record);
      saveSchedules(config.data_dir, agentRecords);

      console.log(
        `[scheduler] Created agent job ${record.id}: ${record.schedule} (${record.description})`,
      );
      return record;
    },

    list(): ScheduleRecord[] {
      return [...agentRecords];
    },

    delete(id: string): boolean {
      const idx = agentRecords.findIndex((r) => r.id === id);
      if (idx === -1) return false;

      stopJob(id);
      agentRecords.splice(idx, 1);
      saveSchedules(config.data_dir, agentRecords);

      console.log(`[scheduler] Deleted agent job ${id}`);
      return true;
    },
  };
}
