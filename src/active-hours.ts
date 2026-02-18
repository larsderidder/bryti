/**
 * Active hours guard.
 *
 * Determines whether the current time falls within the configured active
 * window. Scheduler callbacks use this to skip firing during quiet hours
 * (nights, weekends if needed, etc.).
 *
 * Config shape:
 *   active_hours:
 *     timezone: Europe/Amsterdam   # IANA timezone name
 *     start: "08:00"               # local time, inclusive
 *     end:   "23:00"               # local time, exclusive
 *
 * When active_hours is absent from config, all hours are considered active.
 * Overnight windows (start > end, e.g. 22:00–06:00) are supported.
 */

export interface ActiveHoursConfig {
  /** IANA timezone name, e.g. "Europe/Amsterdam". */
  timezone: string;
  /** Start of active window, "HH:MM", inclusive. */
  start: string;
  /** End of active window, "HH:MM", exclusive. */
  end: string;
}

/**
 * Parse "HH:MM" into total minutes since midnight. Returns NaN on bad input.
 */
function parseHHMM(hhmm: string): number {
  const match = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return NaN;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h > 23 || m > 59) return NaN;
  return h * 60 + m;
}

/**
 * Get the HH:MM minutes for a given Date in the given IANA timezone.
 * Falls back to UTC on unknown timezone.
 */
function currentMinutesInZone(timezone: string, now: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);

    const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    return h * 60 + m;
  } catch {
    // Unknown timezone: fall back to UTC
    console.warn(`[active-hours] Unknown timezone "${timezone}", falling back to UTC`);
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/**
 * Return true if the given time (default: now) is within the active window.
 *
 * When cfg is undefined, always returns true (no restriction configured).
 * The optional `now` parameter exists for testing.
 */
export function isActiveNow(cfg: ActiveHoursConfig | undefined, now?: Date): boolean {
  if (!cfg) return true;

  const startMin = parseHHMM(cfg.start);
  const endMin = parseHHMM(cfg.end);

  if (isNaN(startMin) || isNaN(endMin)) {
    console.warn(
      `[active-hours] Invalid active_hours config (start="${cfg.start}" end="${cfg.end}"), treating as always active`,
    );
    return true;
  }

  const nowMin = currentMinutesInZone(cfg.timezone, now);

  if (startMin <= endMin) {
    // Normal window: 08:00–23:00
    return nowMin >= startMin && nowMin < endMin;
  } else {
    // Overnight window: 22:00–06:00
    return nowMin >= startMin || nowMin < endMin;
  }
}
