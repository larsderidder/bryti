/**
 * Centralized timezone utilities.
 *
 * Single source of truth for all timezone-aware operations in pibot.
 * All datetime strings stored in SQLite use space-separated UTC format
 * ("YYYY-MM-DD HH:MM") so SQLite's datetime() comparisons stay correct.
 *
 * The IANA timezone is sourced from config.agent.timezone. When omitted,
 * all operations fall back to UTC.
 */

import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

/**
 * Return the configured IANA timezone string, or "UTC" when not set.
 */
export function getUserTimezone(config: Config): string {
  return config.agent.timezone || "UTC";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a Date as a local datetime string in the given IANA timezone,
 * using the SQLite-compatible "YYYY-MM-DD HH:MM" format.
 */
export function formatLocal(date: Date, timezone: string): string {
  return date
    .toLocaleString("sv-SE", { timeZone: timezone, hour12: false })
    .slice(0, 16)
    .replace("T", " ");
}

/**
 * Format a Date as a UTC datetime string in "YYYY-MM-DD HH:MM UTC" format.
 */
export function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/**
 * Build the current-time string for the system prompt.
 *
 * When timezone differs from UTC, shows local time with timezone label plus
 * the UTC equivalent. When UTC, shows only UTC.
 */
export function currentTimePromptLine(timezone: string): string {
  const now = new Date();
  const utcStr = formatUtc(now);
  if (timezone === "UTC") {
    return utcStr;
  }
  const localStr = formatLocal(now, timezone);
  return `${localStr} (${timezone}) / ${utcStr}`;
}

// ---------------------------------------------------------------------------
// Conversion: local -> UTC
// ---------------------------------------------------------------------------

/**
 * Convert a naive local datetime string to a UTC datetime string in
 * "YYYY-MM-DD HH:MM" format.
 *
 * Accepts "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM" (with optional seconds).
 * If the input already carries an offset indicator (Z, +HH:MM, -HH:MM), it is
 * parsed as-is and returned in UTC without applying the timezone offset.
 * Date-only strings ("YYYY-MM-DD") are returned unchanged — only strings with a
 * time component are converted.
 *
 * @param naive     Local datetime string from the agent (no offset).
 * @param timezone  IANA timezone the local time is expressed in.
 * @returns         UTC datetime in "YYYY-MM-DD HH:MM" format.
 */
export function toUtc(naive: string, timezone: string): string {
  const normalized = naive.replace("T", " ").trim();

  // Date-only string — no time component to convert
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return normalized;
  }

  // Already has explicit offset — parse and re-format in UTC
  if (/[Z]$/.test(naive) || /[+-]\d{2}:?\d{2}$/.test(naive)) {
    return new Date(naive).toISOString().slice(0, 16).replace("T", " ");
  }

  // Naive local time: interpret in the given timezone and convert to UTC.
  //
  // Strategy (Temporal-free, works in Node 18+):
  // 1. Pretend the local time is UTC to get a Date object we can feed to
  //    toLocaleString.
  // 2. Ask toLocaleString what time that UTC moment is in the target timezone.
  //    The difference between step-1's UTC and step-2's result is the UTC
  //    offset of the timezone at that moment (handles DST correctly).
  // 3. Subtract that offset from the naive-as-UTC date to get the real UTC.
  //
  // This is a fixed-point approximation that is exact when the offset doesn't
  // change during the 1-second window we're looking at — true for all
  // real-world timezones.

  const withSecs = /\d{2}:\d{2}$/.test(normalized)
    ? normalized + ":00"
    : normalized;

  // Parse as if UTC
  const asUtc = new Date(withSecs.replace(" ", "T") + "Z");
  if (isNaN(asUtc.getTime())) {
    // Unparseable — return as-is with separator normalised
    return normalized.slice(0, 16);
  }

  // Get what the timezone thinks this UTC moment is
  const localRepr = asUtc.toLocaleString("sv-SE", { timeZone: timezone, hour12: false });
  // localRepr: "YYYY-MM-DD HH:MM:SS"
  const localAsUtc = new Date(localRepr.replace(" ", "T") + "Z");
  // offset = local - utc (positive means timezone is ahead of UTC)
  const offsetMs = localAsUtc.getTime() - asUtc.getTime();

  // Real UTC = naive local - offset
  const utcDate = new Date(asUtc.getTime() - offsetMs);
  return utcDate.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Convert a UTC datetime string (SQLite format "YYYY-MM-DD HH:MM") to a
 * local datetime string in the given IANA timezone, using the same format.
 *
 * Date-only strings are returned unchanged.
 */
export function toLocal(utcStr: string, timezone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(utcStr.trim())) {
    return utcStr.trim();
  }
  const date = new Date(utcStr.replace(" ", "T") + "Z");
  if (isNaN(date.getTime())) return utcStr;
  return formatLocal(date, timezone);
}
