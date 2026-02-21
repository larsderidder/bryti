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
import { createProjectionStore, formatProjectionsForPrompt, runReflection } from "./projection/index.js";
import { isActiveNow } from "./active-hours.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Given a cron expression, calculate the next fire time after `after` and
 * return it as a UTC datetime string suitable for SQLite ("YYYY-MM-DD HH:MM").
 * Returns null if the expression is invalid or produces no next occurrence.
 */
function nextCronOccurrence(cronExpr: string, after: Date): string | null {
  try {
    const job = new Cron(cronExpr, { timezone: "UTC", startAt: after });
    const next = job.nextRun(after);
    job.stop();
    if (!next) return null;
    return next.toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return null;
  }
}

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
    if (!primaryUserId || primaryUserId === "undefined") {
      console.warn("[projections] No primary user configured (telegram.allowed_users is empty) — projection jobs not started");
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
          const activated = store.evaluateDependencies();
          if (activated > 0) {
            console.log(`[projections] Activated ${activated} projection(s) via dependencies`);
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
              `[Daily review]\n\nHere is what's coming up:\n\n${formatted}\n\n` +
              `Review each item. For each projection, decide whether to surface it TODAY:\n` +
              `1. Search your memory for related context (use memory_archival_search)\n` +
              `2. If due today or overdue: compose a message or take action.\n` +
              `3. If due later this week: surface only if today is the right day for it.\n` +
              `4. If further out: only act if something needs attention now.\n` +
              `5. If cancelled, resolved, or clearly passed: resolve it and move on.\n` +
              `6. If nothing needs to happen: say nothing (NOOP is fine).\n\n` +
              `Timing rules:\n` +
              `- If a task has a hard deadline AND an unresolved blocker (waiting on someone, missing info), ` +
              `surface it EARLY so the user can start unblocking. Don't wait for the blocker to resolve itself.\n` +
              `- If today is a light day and a task is due this week, today is probably a good day to surface it. ` +
              `Don't skip it just because other days look busy.\n` +
              `- Only defer if today is genuinely a bad day (too busy, user is overwhelmed, or a later day is ` +
              `clearly better for a specific reason).`,
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
          store.evaluateDependencies();
          const due = store.getExactDue(15);
          if (due.length === 0) {
            return;
          }
          console.log(`[projections] Exact-time check: ${due.length} item(s) due`);
          const formatted = formatProjectionsForPrompt(due, 10);

          // Settle each projection: rearm recurring ones, mark one-offs as passed.
          const now = new Date();
          for (const p of due) {
            if (p.recurrence) {
              const next = nextCronOccurrence(p.recurrence, now);
              if (next) {
                store.rearm(p.id, next);
                console.log(`[projections] Rearmed recurring projection ${p.id} → next: ${next}`);
              } else {
                // Cron produced no future occurrence — treat as one-off.
                store.resolve(p.id, "passed");
                console.warn(`[projections] Recurring projection ${p.id} produced no next occurrence, marked passed`);
              }
            } else {
              store.resolve(p.id, "passed");
            }
          }

          const msg: IncomingMessage = {
            channelId,
            userId: primaryUserId,
            text:
              `[Scheduled reminder]\n\nThe following reminder(s) are due now:\n\n` +
              `${formatted}\n\n` +
              `For each item:\n` +
              `1. Search your memory for related context (use memory_archival_search)\n` +
              `2. Send the user a helpful, natural message — or reply NOOP if nothing needs to be said.`,
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

  /**
   * Start the reflection cron job.
   *
   * Runs every 30 minutes and scans the last 30 minutes of conversation
   * history for future references the agent may have missed. Writes new
   * projections directly to SQLite — no agent loop involved.
   *
   * Skips automatically when there are no new messages since the last run.
   */
  function startReflectionJob(): void {
    const primaryUserId = String(config.telegram.allowed_users[0] ?? "");
    if (!primaryUserId || primaryUserId === "undefined") {
      return;
    }

    const job = new Cron(
      "*/30 * * * *",
      async () => {
        try {
          const result = await runReflection(config, primaryUserId, 30);
          if (result.skipped) {
            // Only log at debug level — this fires often and is usually a no-op
            return;
          }
          if (result.projectionsAdded > 0) {
            console.log(
              `[reflection] Added ${result.projectionsAdded} projection(s) from recent conversation`,
            );
          } else {
            console.log("[reflection] No new projections found in recent conversation");
          }
        } catch (err) {
          console.error("[reflection] Unhandled error:", (err as Error).message);
        }
      },
      { timezone: "UTC" },
    );
    cronJobs.set("projection-reflection", job);
    console.log("[projections] Reflection pass scheduled every 30 minutes");
  }

  return {
    start(): void {
      startConfigJobs();
      startProjectionJobs();
      startReflectionJob();

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
