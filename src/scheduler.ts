/**
 * Scheduler: three job types, all driving the agent via synthetic messages.
 *
 * 1. Config-driven jobs (startConfigJobs): cron entries from config.yml. The
 *    operator defines the schedule and the message text. Fire unconditionally
 *    regardless of active-hours config.
 *
 * 2. Projection daily review (startProjectionJobs — daily): fires at 08:00 UTC
 *    every day. Sends the agent a broad "what's coming up?" prompt listing all
 *    projections due in the next 7 days. The agent decides what (if anything)
 *    to surface to the user.
 *
 * 3. Projection exact-time check (startProjectionJobs — every 5 min): precise
 *    trigger for projections with a specific datetime. Checks for anything due
 *    within the next 15 minutes. Skips silently outside active hours.
 *
 * All three types construct a synthetic IncomingMessage and pass it to the
 * onMessage callback, which feeds it into the main agent loop exactly as if
 * a real user had sent it.
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
 *
 * Implementation note: croner does not expose a pure "next occurrence"
 * function without constructing a live job. This creates a temporary Cron
 * instance, reads the next run time, then immediately stops it to avoid
 * leaking a running interval.
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
// Daily review bootstrap
// ---------------------------------------------------------------------------

const DAILY_REVIEW_TAG = "__daily_review__";

/**
 * Ensure a daily review projection exists for each known user.
 *
 * The daily review used to be a hardcoded cron job. Now it's a regular
 * recurring projection so the user (and the agent) can modify its schedule
 * with projection_update, just like any other recurring reminder.
 *
 * On first boot (or after a migration), this creates the projection if one
 * doesn't already exist. The tag is used to identify it idempotently.
 */
function bootstrapDailyReview(config: Config): void {
  const mem = config.agent_def.memory;
  if (!mem.daily_review) return;

  const schedule = typeof mem.daily_review === "string"
    ? mem.daily_review
    : "0 8 * * *";

  const knownUsers = getKnownUsers(config);
  for (const userId of knownUsers) {
    const store = createProjectionStore(userId, config.data_dir);
    try {
      // Check if a daily review projection already exists (tagged), or if there's
      // already a recurring morning projection the user set up themselves.
      const pending = store.getUpcoming(365);
      const hasTaggedReview = pending.some(
        (p) => p.recurrence && p.context?.includes(DAILY_REVIEW_TAG),
      );
      if (hasTaggedReview) continue;

      // If the user already has recurring projections in the morning window,
      // they've set up their own routine. Don't add a redundant daily review.
      const hasMorningRecurrence = pending.some((p) => {
        if (!p.recurrence) return false;
        // Check if the cron fires between 06:00-10:00 UTC (morning window)
        const nextRun = nextCronOccurrence(p.recurrence, new Date());
        if (!nextRun) return false;
        const hour = parseInt(nextRun.split(" ")[1]?.split(":")[0] ?? "99", 10);
        return hour >= 6 && hour <= 10;
      });
      if (hasMorningRecurrence) {
        console.log(`[projections] user=${userId} already has morning recurring projections, skipping daily review bootstrap`);
        continue;
      }

      const next = nextCronOccurrence(schedule, new Date());
      if (!next) {
        console.warn(`[projections] Could not compute next daily review occurrence for schedule: ${schedule}`);
        continue;
      }

      const id = store.add({
        summary: "Daily review — check upcoming events, projections, and anything that needs attention today",
        resolved_when: next,
        resolution: "exact",
        recurrence: schedule,
        context:
          `${DAILY_REVIEW_TAG}\n` +
          `Use projection_list to see what's coming up this week. ` +
          `Check email and calendar if you have those tools. ` +
          `Surface anything the user should know about today. ` +
          `If you already sent a morning check earlier today, NOOP. ` +
          `Clean up any duplicate projections you spot.`,
      });
      console.log(`[projections] Bootstrapped daily review projection ${id} for user ${userId} (${schedule})`);
    } finally {
      store.close();
    }
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
 * Return all user IDs that are authorised to use the bot.
 *
 * Combines Telegram and WhatsApp allowed_users into a single deduplicated
 * list of string IDs. This is the canonical source of "known users" for
 * scheduler jobs — more reliable than scanning session directories (which
 * only exist after first contact) and consistent with the auth layer.
 */
function getKnownUsers(config: Config): string[] {
  const ids = new Set<string>();
  for (const id of config.telegram.allowed_users) {
    ids.add(String(id));
  }
  if (config.whatsapp.enabled) {
    for (const id of config.whatsapp.allowed_users) {
      ids.add(String(id));
    }
  }
  return [...ids];
}

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
            // raw.type identifies this as a scheduler message. processMessage() in
        // index.ts checks for this field to skip crash-recovery checkpoints
        // that only make sense for real user messages.
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
   * Exact-time projection check: every 5 minutes, fires timed projections.
   *
   * This is the single scheduling mechanism for all projections. The daily
   * review is a regular recurring projection (bootstrapped on first boot),
   * not a separate cron job.
   *
   * Each user gets their own independent store, message, and onMessage call.
   * Known users are derived from config (telegram.allowed_users +
   * whatsapp.allowed_users) so new users are picked up on the next restart.
   */
  function startExactTimeCheck(): void {
    const knownUsers = getKnownUsers(config);
    if (knownUsers.length === 0) return;

    const exactJob = new Cron(
      "*/5 * * * *",
      async () => {
        if (!isActiveNow(config.active_hours)) {
          return; // Silent skip — fires every 5 min, no need to log each one
        }

        for (const userId of knownUsers) {
          const store = createProjectionStore(userId, config.data_dir);
          try {
            store.evaluateDependencies();
            const expired = store.autoExpire(24);
            if (expired > 0) {
              console.log(`[projections] user=${userId} auto-expired ${expired} stale projection(s)`);
            }
            const due = store.getExactDue(5);
            if (due.length === 0) {
              continue;
            }
            console.log(`[projections] user=${userId} exact-time check: ${due.length} item(s) due`);
            const formatted = formatProjectionsForPrompt(due, 10);

            // Settle each projection: rearm recurring ones, mark one-offs as passed.
            // Use the projection's scheduled time (not `now`) as the base for
            // computing the next occurrence.  The lookahead window fires
            // projections up to 15 min early, so using `now` would compute the
            // *same* occurrence again (e.g., 08:45 → next cron at 09:00 today →
            // fires again at 08:50).  Using `resolved_when` ensures the next
            // occurrence is always in the future relative to the intended time.
            for (const p of due) {
              if (p.recurrence) {
                const scheduledTime = p.resolved_when ? new Date(p.resolved_when + "Z") : new Date();
                const next = nextCronOccurrence(p.recurrence, scheduledTime);
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

            // raw.type marks this as a scheduler message so processMessage() can
            // distinguish it from a real user message and skip crash checkpoints.
            const msg: IncomingMessage = {
              channelId: userId,
              userId,
              text:
                `[Scheduled reminder]\n\nThe following reminder(s) are due now:\n\n` +
                `${formatted}\n\n` +
                `For each item:\n` +
                `1. Search your memory for related context (use memory_archival_search)\n` +
                `2. Execute any actions described in the reminder (check email, check calendar, etc.)\n` +
                `3. Send the user a helpful, natural message with your findings\n\n` +
                `Only reply NOOP if the reminder is purely informational and requires no action or message.`,
              platform: "telegram",
              raw: { type: "projection_exact_check" },
            };
            try {
              await onMessage(msg);
            } catch (err) {
              console.error(`[projections] exact-time check failed for ${userId}:`, (err as Error).message);
            }
          } finally {
            store.close();
          }
        }
      },
      { timezone: "UTC" },
    );
    cronJobs.set("projection-exact", exactJob);
    console.log(`[projections] Exact-time check scheduled every 5 minutes for ${knownUsers.length} user(s)`);
  }

  /**
   * Reflection cron: every 30 minutes, scan recent conversation for future
   * references the agent missed. Writes projections directly to SQLite
   * without touching the agent loop. Skips when there are no new messages.
   *
   * Backoff: consecutive LLM failures (provider outage) cause exponential
   * backoff capped at 8 hours. This avoids log noise and pointless API calls
   * during outages. The backoff resets on the next successful run.
   *
   *   failures  backoff before next attempt
   *   1         30 min  (normal interval, no extra wait)
   *   2         1 h
   *   3         2 h
   *   4         4 h
   *   5+        8 h
   */
  function startReflectionJob(): void {
    const knownUsers = getKnownUsers(config);
    if (knownUsers.length === 0) {
      return;
    }

    const BASE_INTERVAL_MS = 30 * 60 * 1000;
    const MAX_BACKOFF_MS = 8 * 60 * 60 * 1000;

    // Per-user backoff state. Each user has their own failure count and backoff
    // window so a flaky per-user history file doesn't stall every other user.
    const failureCount = new Map<string, number>();
    const backoffUntil = new Map<string, number>();

    const job = new Cron(
      "*/30 * * * *",
      async () => {
        for (const userId of knownUsers) {
          const until = backoffUntil.get(userId) ?? 0;
          // During a backoff window, skip silently — the cron still fires every
          // 30 min so recovery is detected promptly once the window expires.
          if (Date.now() < until) {
            continue;
          }

          try {
            const result = await runReflection(config, userId, 30);

            // Success: clear per-user backoff state.
            const prevFailures = failureCount.get(userId) ?? 0;
            if (prevFailures > 0) {
              console.log(`[reflection] user=${userId} recovered after ${prevFailures} consecutive failure(s)`);
              failureCount.set(userId, 0);
              backoffUntil.set(userId, 0);
            }

            if (result.skipped) {
              // Only log at debug level — this fires often and is usually a no-op
              continue;
            }
            if (result.projectionsAdded > 0) {
              console.log(
                `[reflection] user=${userId} added ${result.projectionsAdded} projection(s) from recent conversation`,
              );
            } else {
              console.log(`[reflection] user=${userId} no new projections found in recent conversation`);
            }
          } catch (err) {
            const failures = (failureCount.get(userId) ?? 0) + 1;
            failureCount.set(userId, failures);
            // Exponential backoff: 30m * 2^(failures-1), capped at 8h.
            const delayMs = Math.min(
              BASE_INTERVAL_MS * Math.pow(2, failures - 1),
              MAX_BACKOFF_MS,
            );
            backoffUntil.set(userId, Date.now() + delayMs);
            const delayMin = Math.round(delayMs / 60_000);
            console.error(
              `[reflection] user=${userId} failure #${failures}: ${(err as Error).message}. ` +
              `Backing off for ${delayMin} min (until ${new Date(Date.now() + delayMs).toISOString()})`,
            );
          }
        }
      },
      { timezone: "UTC" },
    );
    cronJobs.set("projection-reflection", job);
    console.log(`[projections] Reflection pass scheduled every 30 minutes for ${knownUsers.length} user(s)`);
  }

  return {
    start(): void {
      startConfigJobs();

      // Projection and reflection jobs are opt-in via the agent definition.
      //
      // daily_review: the 08:00 UTC "what's coming up?" pass. Personal
      //   assistant feature. A devops monitor has no morning briefing concept.
      //
      // projection_exact_check: the every-5-min precise trigger. Enabled
      //   whenever the projections tool group is active (i.e. when the agent
      //   definition includes projections at all). The scheduler doesn't have
      //   direct visibility into tool groups, but daily_review=false and
      //   reflection=true is the operational pattern, so we use that as the
      //   signal: always start the exact-time check unless we have no
      //   projection jobs at all.
      //
      // reflection: the every-30-min pass that extracts projections from
      //   conversation history. Useful for both personal assistants (scheduling)
      //   and operational agents (learning patterns).
      const mem = config.agent_def.memory;

      // Bootstrap the daily review projection if enabled. The exact-time
      // check fires it like any other recurring projection.
      if (mem.daily_review) {
        bootstrapDailyReview(config);
      }
      startExactTimeCheck();

      if (mem.reflection) {
        startReflectionJob();
      }

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
