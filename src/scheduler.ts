/**
 * Scheduler: config cron jobs, projection reminders, and reflection.
 *
 * Scheduled projection delivery is durable. The scheduler assigns a stable
 * work id for each projection occurrence, enqueues one synthetic message per
 * occurrence, then waits for the work receipt before rearming or resolving the
 * projection. Enqueue acceptance is not treated as execution or delivery.
 */

import { Cron } from "croner";
import type { Config } from "./config.js";
import type { IncomingMessage, Platform } from "./channels/types.js";
import {
  createProjectionStore,
  formatProjectionsForPrompt,
  runReflection,
  type Projection,
  type ProjectionStore,
} from "./projection/index.js";
import { isActiveNow } from "./active-hours.js";
import { getUserTimezone } from "./time.js";
import { createDeviceStore } from "./web-e2ee/device-store.js";
import { createWorkStore, type WorkRecord, type WorkStore } from "./work/store.js";
import { scheduledWorkId, OBSOLETE_PROJECTION_WORK } from "./projection/occurrence.js";
import { createCommandStore } from "./work/commands.js";
export { scheduledWorkId } from "./projection/occurrence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Given a cron expression, calculate the next fire time after `after` and
 * return it as a UTC datetime string suitable for SQLite ("YYYY-MM-DD HH:MM").
 * Returns null if the expression is invalid or produces no next occurrence.
 */
function nextCronOccurrence(cronExpr: string, after: Date, timezone = "UTC"): string | null {
  try {
    const job = new Cron(cronExpr, { timezone, startAt: after });
    const next = job.nextRun(after);
    job.stop();
    if (!next) {
      return null;
    }
    return next.toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return null;
  }
}

function runNonOverlapping(name: string, fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      console.warn(`[scheduler] Skipping overlapping ${name} run`);
      return;
    }
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Delivery targets
// ---------------------------------------------------------------------------

export interface SchedulerTarget {
  userId: string;
  channelId: string;
  platform: Platform;
  threadId?: string;
  channelThreadId?: string;
}

function targetKey(target: SchedulerTarget): string {
  return JSON.stringify([
    target.userId,
    target.channelId,
    target.platform,
    target.threadId ?? null,
    target.channelThreadId ?? null,
  ]);
}

function addTarget(targets: Map<string, SchedulerTarget>, target: SchedulerTarget): void {
  targets.set(targetKey(target), target);
}

/** Return configured fallback delivery targets that are authorized for use. */
export function getSchedulerTargets(config: Config): SchedulerTarget[] {
  const targets = new Map<string, SchedulerTarget>();

  if (config.telegram.token) {
    for (const id of config.telegram.allowed_users) {
      const userId = String(id);
      addTarget(targets, { userId, channelId: userId, platform: "telegram" });
    }

    if (config.telegram.mode === "group") {
      for (const user of config.telegram.allowed_users) {
        for (const group of config.telegram.allowed_groups ?? []) {
          addTarget(targets, {
            userId: String(user),
            channelId: String(group),
            platform: "telegram",
          });
        }
      }
    }
  }

  if (config.whatsapp.enabled) {
    for (const id of config.whatsapp.allowed_users) {
      const userId = String(id);
      addTarget(targets, { userId, channelId: userId, platform: "whatsapp" });
    }
  }

  if (config.threema.enabled) {
    for (const id of config.threema.allowed_senders) {
      const userId = String(id);
      addTarget(targets, { userId, channelId: userId, platform: "threema" });
    }
  }

  if (config.web_e2ee.enabled) {
    try {
      const deviceStore = createDeviceStore(config.data_dir);
      for (const device of deviceStore.list()) {
        if (device.status !== "active") {
          continue;
        }
        addTarget(targets, {
          userId: device.deviceId,
          channelId: device.deviceId,
          platform: "web_e2ee",
        });
      }
    } catch (err) {
      console.warn(`[web_e2ee] Could not load scheduler targets: ${(err as Error).message}`);
    }
  }

  return [...targets.values()];
}

function targetsByUserId(targets: SchedulerTarget[]): Map<string, SchedulerTarget[]> {
  const grouped = new Map<string, SchedulerTarget[]>();
  for (const target of targets) {
    const existing = grouped.get(target.userId) ?? [];
    existing.push(target);
    grouped.set(target.userId, existing);
  }
  return grouped;
}

export function targetFromProjection(projection: Projection): SchedulerTarget | null {
  if (!projection.target_user_id || !projection.target_channel_id || !projection.target_platform) {
    return null;
  }

  return {
    userId: projection.target_user_id,
    channelId: projection.target_channel_id,
    platform: projection.target_platform as Platform,
    threadId: projection.target_thread_id ?? undefined,
    channelThreadId: projection.target_channel_thread_id ?? undefined,
  };
}

export function isTargetAllowed(config: Config, target: SchedulerTarget): boolean {
  if (target.platform === "telegram") {
    if (!config.telegram.token) {
      return false;
    }
    const allowedUser = config.telegram.allowed_users.map(String).includes(target.userId);
    if (!allowedUser) {
      return false;
    }
    if (target.channelId === target.userId) {
      return true;
    }
    return config.telegram.mode === "group"
      && (config.telegram.allowed_groups ?? []).map(String).includes(target.channelId);
  }

  if (target.platform === "whatsapp") {
    return config.whatsapp.enabled
      && target.channelId === target.userId
      && config.whatsapp.allowed_users.includes(target.userId);
  }

  if (target.platform === "threema") {
    return config.threema.enabled
      && target.channelId === target.userId
      && config.threema.allowed_senders.includes(target.userId);
  }

  if (target.platform === "web_e2ee") {
    if (!config.web_e2ee.enabled || target.channelId !== target.userId) {
      return false;
    }
    try {
      return Boolean(createDeviceStore(config.data_dir).getActive(target.channelId));
    } catch (err) {
      console.warn(`[web_e2ee] Could not validate scheduler target ${target.channelId}: ${(err as Error).message}`);
      return false;
    }
  }

  return false;
}

function targetForProjection(
  config: Config,
  ownerUserId: string,
  projection: Projection,
  fallbackTarget: SchedulerTarget,
): SchedulerTarget | null {
  const storedTarget = targetFromProjection(projection);
  if (!storedTarget) {
    if (!isTargetAllowed(config, fallbackTarget)) {
      return null;
    }
    return fallbackTarget;
  }

  if (storedTarget.userId !== ownerUserId) {
    return null;
  }
  if (!isTargetAllowed(config, storedTarget)) {
    return null;
  }
  return storedTarget;
}

export function groupDueByTarget(
  due: Projection[],
  fallbackTarget: SchedulerTarget,
): Map<string, { target: SchedulerTarget; projections: Projection[] }> {
  const grouped = new Map<string, { target: SchedulerTarget; projections: Projection[] }>();
  for (const projection of due) {
    const target = targetFromProjection(projection) ?? fallbackTarget;
    const key = targetKey(target);
    const entry = grouped.get(key) ?? { target, projections: [] };
    entry.projections.push(projection);
    grouped.set(key, entry);
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// Daily review bootstrap
// ---------------------------------------------------------------------------

const DAILY_REVIEW_TAG = "__daily_review__";

function bootstrapDailyReview(config: Config): void {
  const mem = config.agent_def.memory;
  if (!mem.daily_review) {
    return;
  }

  let schedule = "0 8 * * *";
  if (typeof mem.daily_review === "string") {
    schedule = mem.daily_review;
  }

  const targets = getSchedulerTargets(config);
  const groupedTargets = targetsByUserId(targets);
  for (const [userId, userTargets] of groupedTargets) {
    const fallbackTarget = userTargets[0];
    if (!fallbackTarget) {
      continue;
    }
    const store = createProjectionStore(userId, config.data_dir);
    try {
      const pending = store.getUpcoming(365);
      const hasTaggedReview = pending.some(
        (p) => p.recurrence && p.context?.includes(DAILY_REVIEW_TAG),
      );
      if (hasTaggedReview) {
        continue;
      }

      const hasMorningRecurrence = pending.some((p) => {
        if (!p.recurrence) {
          return false;
        }
        const userTz = getUserTimezone(config);
        const nextRun = nextCronOccurrence(p.recurrence, new Date(), userTz);
        if (!nextRun) {
          return false;
        }
        const hour = parseInt(nextRun.split(" ")[1]?.split(":")[0] ?? "99", 10);
        return hour >= 6 && hour <= 10;
      });
      if (hasMorningRecurrence) {
        console.log(`[projections] user=${userId} already has morning recurring projections, skipping daily review bootstrap`);
        continue;
      }

      const userTz = getUserTimezone(config);
      const next = nextCronOccurrence(schedule, new Date(), userTz);
      if (!next) {
        console.warn(`[projections] Could not compute next daily review occurrence for schedule: ${schedule}`);
        continue;
      }

      const id = store.add({
        summary: "Daily review, check upcoming events, projections, and anything that needs attention today",
        resolved_when: next,
        resolution: "exact",
        recurrence: schedule,
        target: fallbackTarget,
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
  start(): void;
  stop(): void;
}

type SchedulerMessageCallback = (msg: IncomingMessage) => Promise<void | boolean> | void | boolean;


function shouldSettleReceipt(receipt: WorkRecord | null): boolean {
  if (!receipt) {
    return false;
  }
  if (receipt.execution !== "completed") {
    return false;
  }
  return receipt.delivery === "delivered" || receipt.delivery === "none";
}

function settleProjection(store: ProjectionStore, projection: Projection, timezone: string, reconciled = false): void {
  if (projection.recurrence) {
    let scheduledTime = new Date();
    if (projection.resolved_when) {
      scheduledTime = new Date(projection.resolved_when + "Z");
    }
    if (reconciled && scheduledTime.getTime() < Date.now()) {
      // Recovery resumes the schedule from now, never with catch-up executions.
      scheduledTime = new Date();
    }
    const next = nextCronOccurrence(projection.recurrence, scheduledTime, timezone);
    if (next) {
      store.rearm(projection.id, next);
      console.log(`[projections] Rearmed recurring projection ${projection.id} -> next: ${next}`);
      return;
    }
    store.resolve(projection.id, "passed");
    console.warn(`[projections] Recurring projection ${projection.id} produced no next occurrence, marked passed`);
    return;
  }

  store.resolve(projection.id, "passed");
}

function projectionReminderText(projection: Projection): string {
  const formatted = formatProjectionsForPrompt([projection], 1);
  return `[Scheduled reminder]\n\nThe following reminder is due now:\n\n` +
    `${formatted}\n\n` +
    `For this item:\n` +
    `1. Search your memory for related context with memory_archival_search.\n` +
    `2. Execute any actions described in the reminder, such as checking email or calendar.\n` +
    `3. Send the user a helpful, natural message with your findings.\n\n` +
    `Only reply NOOP if the reminder is purely informational and requires no action or message.`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScheduler(
  config: Config,
  onMessage: SchedulerMessageCallback,
  suppliedWorkStore?: WorkStore,
): Scheduler {
  const cronJobs = new Map<string, Cron>();
  const workStore = suppliedWorkStore ?? createWorkStore(config.data_dir);
  const ownsWorkStore = !suppliedWorkStore;
  const commands = createCommandStore(config.data_dir);

  function defaultTarget(): SchedulerTarget | null {
    return getSchedulerTargets(config)[0] ?? null;
  }

  async function enqueueScheduledMessage(store: ProjectionStore, ownerUserId: string, projection: Projection, target: SchedulerTarget): Promise<void> {
    const workId = scheduledWorkId(ownerUserId, projection);
    const msg: IncomingMessage = {
      channelId: target.channelId,
      userId: target.userId,
      threadId: target.threadId,
      channelThreadId: target.channelThreadId,
      text: projectionReminderText(projection),
      platform: target.platform,
      workId,
      workIds: [workId],
      raw: { type: "projection_exact_check" },
    };

    const accepted = await onMessage(msg);
    if (accepted === false) {
      console.warn(`[projections] enqueue rejected for projection ${projection.id} (${workId})`);
      return;
    }

    try {
      workStore.accept(msg);
    } catch (err) {
      console.error(`[projections] work receipt acceptance failed for ${projection.id}:`, (err as Error).message);
      return;
    }

    const receipt = workStore.get(workId);
    if (!receipt) {
      console.error(`[projections] no work receipt after accepted enqueue for ${projection.id}: ${workId}`);
      return;
    }

    if (!store.markDeliveryWork(projection.id, workId)) {
      console.warn(`[projections] could not mark delivery work id for projection ${projection.id}: ${workId}`);
    }
  }


  function recoverAcceptedOccurrenceLinks(store: ProjectionStore, userId: string): void {
    for (const projection of store.getPendingExact()) {
      if (projection.delivery_work_id) {
        continue;
      }
      const workId = scheduledWorkId(userId, projection);
      if (!workStore.get(workId)) {
        continue;
      }
      if (store.markDeliveryWork(projection.id, workId)) {
        console.log(`[projections] user=${userId} recovered delivery marker for projection ${projection.id} (${workId})`);
      }
    }
  }

  async function reconcileAcceptedOccurrences(store: ProjectionStore, userId: string, timezone: string): Promise<void> {
    const awaiting = store.getAwaitingDelivery();
    for (const projection of awaiting) {
      const workId = projection.delivery_work_id;
      if (!workId) {
        continue;
      }
      const receipt = workStore.get(workId);
      if (receipt?.execution === "failed" && receipt.error === OBSOLETE_PROJECTION_WORK) {
        store.clearDeliveryWork(projection.id, workId);
        continue;
      }
      const managedCommands = commands.forWork(workId);
      const reconciled = commands.isReconciled(workId, workStore);
      if (managedCommands.length > 0 && !reconciled) {
        // Dispatch is not completion. The durable command event owns the review.
        continue;
      }
      if (!reconciled && !shouldSettleReceipt(receipt)) {
        if (receipt && (receipt.execution === "failed" || receipt.execution === "interrupted"
          || (receipt.execution === "completed" && ["failed", "unknown"].includes(receipt.delivery)))) {
          const noticeId = `blocked:${workId}`;
          if (!workStore.get(noticeId) && isTargetAllowed(config, receipt.message)) {
            let description = "This reminder is blocked pending review.";
            if (projection.recurrence) {
              description = "This recurring schedule is paused pending review.";
            }
            const notice: IncomingMessage = {
              ...receipt.message,
              workId: noticeId,
              workIds: [noticeId],
              images: undefined,
              audio: undefined,
              replyMode: "text",
              text: `Reminder: ${projection.summary}\n${description}\nExecution: ${receipt.execution}. Delivery: ${receipt.delivery}.\nNo actions were automatically repeated. Use /work ${workId} to inspect the receipt. After checking the outcome, explicitly cancel this reminder or ask for a new occurrence.`,
              raw: { type: "recovery_notice" },
            };
            if (await onMessage(notice) !== false) {
              workStore.accept(notice);
            }
          }
        }
        continue;
      }
      if (projection.status === "pending") {
        settleProjection(store, projection, timezone, reconciled);
      } else {
        store.clearDeliveryWork(projection.id, workId);
      }
      console.log(`[projections] user=${userId} settled delivered projection occurrence ${projection.id} (${workId})`);
    }
  }

  function startConfigJobs(): void {
    for (let i = 0; i < config.cron.length; i++) {
      const cronJob = config.cron[i];
      const key = `config-${i}`;
      try {
        const job = new Cron(
          cronJob.schedule,
          runNonOverlapping(key, async () => {
            console.log(`[scheduler] Config job triggered: ${cronJob.schedule}`);
            const target = defaultTarget();
            if (!target) {
              console.warn(`[scheduler] Config job skipped because no authorized target is configured: ${cronJob.schedule}`);
              return;
            }
            const msg: IncomingMessage = {
              channelId: target.channelId,
              userId: target.userId,
              threadId: target.threadId,
              channelThreadId: target.channelThreadId,
              text: cronJob.message,
              platform: target.platform,
              raw: { type: "cron", schedule: cronJob.schedule },
            };
            const accepted = await onMessage(msg);
            if (accepted === false) {
              console.warn(`[scheduler] Config job enqueue rejected: ${cronJob.schedule}`);
            }
          }),
          { timezone: "UTC" },
        );
        cronJobs.set(key, job);
        let preview = cronJob.message;
        if (cronJob.message.length > 50) {
          preview = `${cronJob.message.substring(0, 50)}...`;
        }
        console.log(`[scheduler] Config job scheduled: ${cronJob.schedule} -> ${preview}`);
      } catch (err) {
        console.error(`[scheduler] Failed to schedule config job: ${cronJob.schedule}`, err);
      }
    }
  }

  function startExactTimeCheck(): void {
    const targets = getSchedulerTargets(config);
    const groupedTargets = targetsByUserId(targets);
    if (targets.length === 0) {
      return;
    }

    const exactJob = new Cron(
      "*/5 * * * *",
      runNonOverlapping("projection-exact", async () => {
        if (!isActiveNow(config.active_hours)) {
          return;
        }

        for (const [userId, userTargets] of groupedTargets) {
          const fallbackTarget = userTargets[0];
          if (!fallbackTarget) {
            continue;
          }
          const store = createProjectionStore(userId, config.data_dir);
          try {
            const userTz = getUserTimezone(config);
            recoverAcceptedOccurrenceLinks(store, userId);
            await reconcileAcceptedOccurrences(store, userId, userTz);
            store.evaluateDependencies();

            const rearmed = store.rearmMissed(userTz);
            if (rearmed.length > 0) {
              console.log(`[projections] user=${userId} rearmed ${rearmed.length} missed recurring projection(s): ${rearmed.join(", ")}`);
            }
            const expired = store.autoExpire(24);
            if (expired > 0) {
              console.log(`[projections] user=${userId} auto-expired ${expired} stale projection(s)`);
            }

            const due = store.getExactDue(5);
            if (due.length === 0) {
              continue;
            }
            console.log(`[projections] user=${userId} exact-time check: ${due.length} item(s) due`);

            for (const projection of due) {
              const target = targetForProjection(config, userId, projection, fallbackTarget);
              if (!target) {
                console.warn(`[projections] user=${userId} projection ${projection.id} has no valid scheduler target, leaving pending`);
                continue;
              }
              try {
                await enqueueScheduledMessage(store, userId, projection, target);
              } catch (err) {
                console.error(`[projections] exact-time enqueue failed for ${userId}/${projection.id}:`, (err as Error).message);
              }
            }
          } finally {
            store.close();
          }
        }
      }),
      { timezone: "UTC" },
    );
    cronJobs.set("projection-exact", exactJob);
    console.log(`[projections] Exact-time check scheduled every 5 minutes for ${targets.length} target(s)`);
  }

  function startReflectionJob(): void {
    const targets = getSchedulerTargets(config);
    const groupedTargets = targetsByUserId(targets);
    if (targets.length === 0) {
      return;
    }

    const BASE_INTERVAL_MS = 30 * 60 * 1000;
    const MAX_BACKOFF_MS = 8 * 60 * 60 * 1000;
    const failureCount = new Map<string, number>();
    const backoffUntil = new Map<string, number>();

    const job = new Cron(
      "*/30 * * * *",
      runNonOverlapping("projection-reflection", async () => {
        for (const userId of groupedTargets.keys()) {
          const until = backoffUntil.get(userId) ?? 0;
          if (Date.now() < until) {
            continue;
          }

          try {
            const result = await runReflection(config, userId, 30);
            const prevFailures = failureCount.get(userId) ?? 0;
            if (prevFailures > 0) {
              console.log(`[reflection] user=${userId} recovered after ${prevFailures} consecutive failure(s)`);
              failureCount.set(userId, 0);
              backoffUntil.set(userId, 0);
            }

            if (result.skipped) {
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
      }),
      { timezone: "UTC" },
    );
    cronJobs.set("projection-reflection", job);
    console.log(`[projections] Reflection pass scheduled every 30 minutes for ${targets.length} target(s)`);
  }

  return {
    start(): void {
      startConfigJobs();

      const mem = config.agent_def.memory;
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
      commands.close();
      cronJobs.clear();
      if (ownsWorkStore) {
        workStore.close();
      }
      if (count > 0) {
        console.log(`[scheduler] Stopped ${count} jobs`);
      }
    },
  };
}
