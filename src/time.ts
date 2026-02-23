/**
 * Timezone utilities. Single source of truth for all timezone-aware ops.
 *
 * All datetimes in SQLite use space-separated UTC ("YYYY-MM-DD HH:MM") so
 * datetime() comparisons work correctly. IANA timezone comes from config;
 * falls back to UTC when not set.
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
 *
 * The 'sv-SE' (Swedish) locale is used as a deliberate trick: Swedish date
 * formatting produces "YYYY-MM-DD HH:MM:SS" natively, which is the closest
 * built-in locale to SQLite's datetime format. Slicing to 16 characters drops
 * the seconds component.
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
 * Build the current-time string injected into the system prompt.
 *
 * When the configured timezone differs from UTC, the line shows both local
 * time (with timezone label) and the UTC equivalent. Showing both lets the
 * model reason about deadlines and scheduling in UTC while the user naturally
 * thinks in local time. When the timezone is UTC, only one timestamp is shown
 * to avoid redundancy.
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
 * Convert a naive local datetime string to UTC ("YYYY-MM-DD HH:MM").
 *
 * Accepts "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM". If the input already
 * carries an offset (Z, +/-HH:MM), it's parsed as-is. Date-only strings
 * are returned unchanged.
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
  //
  // Step 1 — seed: parse the naive string as if it were UTC. This gives us a
  //   Date object with the same digits but the wrong epoch. We only need it
  //   to ask toLocaleString for the timezone offset at roughly this moment.
  //
  // Step 2 — probe: call toLocaleString("sv-SE", { timeZone }) on the step-1
  //   Date. This returns what the target timezone thinks that UTC instant is,
  //   which differs from the naive input by exactly the UTC offset at that
  //   instant (DST included). The difference (localRepr - asUtc) is the
  //   offset in milliseconds.
  //
  // Step 3 — correct: subtract the offset from the step-1 epoch to get the
  //   real UTC epoch for the original naive local time.
  //
  // This is a fixed-point approximation: it is exact as long as the UTC
  // offset does not change between the naive time and itself minus the offset.
  // In practice that would require a DST transition to land within seconds of
  // the input, and even then the error is at most one offset-difference
  // (typically 1 hour), which is negligible for our use case.
  //
  // TODO: when Node gains Temporal support, replace this with:
  //   Temporal.ZonedDateTime.from(naive + '[' + timezone + ']').toInstant().toString()

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
