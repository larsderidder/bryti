/**
 * Scheduler.
 *
 * Manages two kinds of scheduled jobs:
 * - Config-driven: defined in config.yml under `cron`, operator-controlled.
 * - Projection-driven: two automatic jobs that surface projections to the agent.
 *
 * Both kinds inject synthetic IncomingMessages into the agent loop, routed to
 * the first allowed Telegram user's channel.
 *
 * Agent-managed schedules (create/list/delete) have been removed. The agent
 * uses projections for everything about the future: reminders, deadlines,
 * plans. Projections are the single concept for forward-looking behavior.
 */

import { Cron } from "croner";
import type { Config } from "./config.js";
import type { IncomingMessage } from "./channels/types.js";
import { createProjectionStore, formatProjectionsForPrompt } from "./projection/index.js";
import { isActiveNow } from "./active-hours.js";

// ---------------------------------------------------------------------------
// Scheduler interface
// ---------------------------------------------------------------------------

export interface Scheduler {
  /** Start all jobs (config-driven and projection-driven). */
  start(): void;

  /** Stop all running jobs. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the scheduler.
 *
 * @param config      App config (for config.yml cron jobs and the default channel).
 * @param onMessage   Callback to inject synthetic messages into the agent loop.
 */
export function createScheduler(
  config: Config,
  onMessage: (msg: IncomingMessage) => Promise<void>,
): Scheduler {
  const cronJobs = new Map<string, Cron>();

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
        const preview = cronJob.message.length > 50
          ? `${cronJob.message.substring(0, 50)}...`
          : cronJob.message;
        console.log(`[scheduler] Config job scheduled: ${cronJob.schedule} -> ${preview}`);
      } catch (err) {
        console.error(`[scheduler] Failed to schedule config job: ${cronJob.schedule}`, err);
      }
    }
  }

  /**
   * Start the two projection-aware scheduled jobs for the primary user:
   *
   * - Daily review at 8am UTC: surfaces all of today's and this week's
   *   projections. Auto-expires stale ones first. One LLM call per day.
   *
   * - Exact-time check every 5 minutes: queries for 'exact' projections due
   *   within the next 15 minutes. Fires the agent only when something matches.
   *   Tight enough for precise reminders ("remind me at 13:45").
   */
  function startProjectionJobs(): void {
    const primaryUserId = String(config.telegram.allowed_users[0] ?? "");
    if (!primaryUserId) {
      return;
    }

    const channelId = defaultChannelId();

    // Daily review: 8am UTC every day
    const dailyJob = new Cron(
      "0 8 * * *",
      async () => {
        if (!isActiveNow(config.active_hours)) {
          console.log("[projections] Daily review skipped (outside active hours)");
          return;
        }
        console.log("[projections] Daily review triggered");
        const store = createProjectionStore(primaryUserId, config.data_dir);
        try {
          const expired = store.autoExpire(24);
          if (expired > 0) {
            console.log(`[projections] Auto-expired ${expired} stale projection(s)`);
          }
          const upcoming = store.getUpcoming(7);
          if (upcoming.length === 0) {
            console.log("[projections] Daily review: no upcoming projections, skipping");
            return;
          }
          const formatted = formatProjectionsForPrompt(upcoming, 20);
          const msg: IncomingMessage = {
            channelId,
            userId: primaryUserId,
            text:
              `[Daily projection review]\n\nHere are your upcoming projections:\n\n${formatted}\n\n` +
              `Review each one. For items due today or this week:\n` +
              `1. Search archival memory for related context (use archival_memory_search with keywords from the projection)\n` +
              `2. Decide whether to message the user, take an action, or do nothing\n` +
              `For items further out, only act if something needs attention now. Resolve any that have clearly passed.`,
            platform: "telegram",
            raw: { type: "projection_daily_review" },
          };
          await onMessage(msg);
        } finally {
          store.close();
        }
      },
      { timezone: "UTC" },
    );
    cronJobs.set("projection-daily", dailyJob);
    console.log("[projections] Daily review scheduled at 08:00 UTC");

    // Exact-time check: every 5 minutes
    const exactJob = new Cron(
      "*/5 * * * *",
      async () => {
        if (!isActiveNow(config.active_hours)) {
          return; // Silent skip - fires every 5 min, no need to log each one
        }
        const store = createProjectionStore(primaryUserId, config.data_dir);
        try {
          const due = store.getExactDue(15);
          if (due.length === 0) {
            return;
          }
          console.log(`[projections] Exact-time check: ${due.length} projection(s) due within 15 minutes`);
          const formatted = formatProjectionsForPrompt(due, 10);
          const msg: IncomingMessage = {
            channelId,
            userId: primaryUserId,
            text:
              `[Projection time check]\n\nThe following exact-time projection(s) are due within the next 15 minutes:\n\n` +
              `${formatted}\n\n` +
              `For each projection:\n` +
              `1. Search archival memory for related context (use archival_memory_search with keywords from the projection)\n` +
              `2. Decide what to do: send a timely message to the user incorporating any relevant memories, or do nothing if it's not actionable yet.`,
            platform: "telegram",
            raw: { type: "projection_exact_check" },
          };
          await onMessage(msg);
        } finally {
          store.close();
        }
      },
      { timezone: "UTC" },
    );
    cronJobs.set("projection-exact", exactJob);
    console.log("[projections] Exact-time check scheduled every 5 minutes");
  }

  return {
    start(): void {
      startConfigJobs();
      startProjectionJobs();

      const total = cronJobs.size;
      if (total > 0) {
        console.log(`[scheduler] Started ${total} jobs (${config.cron.length} config, rest projection)`);
      }
    },

    stop(): void {
      for (const job of cronJobs.values()) {
        job.stop();
      }
      const count = cronJobs.size;
      cronJobs.clear();
      if (count > 0) {
        console.log(`[scheduler] Stopped ${count} jobs`);
      }
    },
  };
}
