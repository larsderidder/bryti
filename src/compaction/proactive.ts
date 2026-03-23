/**
 * Proactive compaction: idle and nightly.
 *
 * Pi SDK auto-compacts when the context fills, but that's mid-conversation
 * and adds latency. Proactive compaction runs during quiet periods instead:
 *
 * - **Idle compaction**: After 30 minutes of inactivity, compact sessions
 *   that are using more than 30% of their context window.
 * - **Nightly compaction**: At 03:00 user timezone, compact all sessions
 *   to start the day with a clean slate.
 */

import { Cron } from "croner";
import type { UserSession } from "../agent.js";
import type { Config } from "../config.js";
import { getUserTimezone } from "../time.js";

const IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_CONTEXT_THRESHOLD = 30; // percent of context window

/**
 * Try to compact a session. Skips if already in progress or if the session
 * is too small to bother with.
 *
 * @param strategy "conversational" (personal assistant) or "operational"
 *   (monitoring agent). Controls the compaction hint injected into the prompt.
 *   Defaults to "conversational" to preserve existing behavior.
 */
export async function tryCompact(
  userSession: UserSession,
  reason: string,
  strategy: "conversational" | "operational" = "conversational",
): Promise<void> {
  const { session, userId } = userSession;
  if (session.isCompacting) return;

  // Don't compact tiny sessions (system + a couple messages)
  const messageCount = session.messages.length;
  if (messageCount < 6) return;

  // Idle compaction: only when context is above threshold. No point compacting
  // a mostly-empty context just because the user stepped away.
  // Nightly compaction always runs (fresh start for the morning).
  if (reason !== "nightly") {
    const usage = session.getContextUsage();
    const percent = usage?.percent ?? 0;
    if (percent < IDLE_CONTEXT_THRESHOLD) {
      return;
    }
  }

  console.log(`[compaction] proactive ${reason} for user ${userId} (${messageCount} messages)`);
  try {
    let reasonHint: string;
    let contextHint: string;

    if (strategy === "operational") {
      reasonHint = reason === "nightly"
        ? "This is a scheduled compaction. The agent runs 24/7. " +
          "Summarize the session's observations and actions into a concise operational log."
        : "The agent has been idle. " +
          "Summarize completed checks and preserve the state of any ongoing monitoring.";
      contextHint =
        "This is an operational monitoring agent. " +
        "Preserve: observed errors and anomalies, patterns identified, active alerts, " +
        "monitoring state, decisions made, and any context needed to continue monitoring. " +
        "Discard: verbose tool outputs, raw log data, intermediate reasoning, and resolved alerts.";
    } else {
      // conversational (default)
      reasonHint = reason === "nightly"
        ? "This is a nightly compaction. The user is asleep. " +
          "Summarize the entire day's conversation into a concise recap. " +
          "Tomorrow's session should start clean with full context of what happened today."
        : "The user has been inactive for a while and may return to continue. " +
          "Summarize completed topics but preserve the thread of any ongoing discussion.";
      contextHint =
        "This is a personal assistant conversation. " +
        "Preserve: user preferences, commitments and promises made, ongoing tasks, " +
        "facts learned about the user, decisions made, and any context the user would " +
        "expect the assistant to remember. " +
        "Discard: verbose tool outputs, raw search results, intermediate reasoning, " +
        "and conversational filler.";
    }

    await session.compact(`${reasonHint} ${contextHint}`);
    console.log(`[compaction] proactive ${reason} done for user ${userId}`);
  } catch (err) {
    console.error(`[compaction] proactive ${reason} failed for user ${userId}:`, (err as Error).message);
  }
}

/**
 * Start proactive compaction cron jobs.
 * Returns the cron jobs so the caller can stop them on shutdown.
 */
export function startProactiveCompaction(
  config: Config,
  getSessions: () => Map<string, UserSession>,
): Cron[] {
  const jobs: Cron[] = [];

  const strategy = config.agent_def.memory.compaction;

  // Check every 10 minutes: compact sessions idle for 30+ minutes
  const idleCheck = new Cron("*/10 * * * *", { timezone: "UTC" }, () => {
    const now = Date.now();
    for (const [_userId, userSession] of getSessions()) {
      const idleMs = now - userSession.lastUserMessageAt;
      if (idleMs >= IDLE_THRESHOLD_MS) {
        tryCompact(userSession, "idle", strategy).catch(() => {});
      }
    }
  });
  jobs.push(idleCheck);

  // Nightly compaction at 03:00 user timezone (all sessions)
  const tz = getUserTimezone(config);
  const nightlyCompact = new Cron("0 3 * * *", { timezone: tz }, () => {
    for (const [_userId, userSession] of getSessions()) {
      tryCompact(userSession, "nightly", strategy).catch(() => {});
    }
  });
  jobs.push(nightlyCompact);

  console.log(`Proactive compaction: idle check every 10 min (threshold: 30 min), nightly at 03:00 ${tz}`);

  return jobs;
}
