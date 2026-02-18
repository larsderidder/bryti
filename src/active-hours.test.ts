import { describe, it, expect } from "vitest";
import { isActiveNow } from "./active-hours.js";
import type { ActiveHoursConfig } from "./active-hours.js";

// Build a Date that corresponds to a given UTC time.
// We test in UTC to keep tests timezone-independent.
function utcDate(hour: number, minute: number): Date {
  const d = new Date(0);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

const utcCfg: ActiveHoursConfig = {
  timezone: "UTC",
  start: "08:00",
  end: "23:00",
};

describe("isActiveNow", () => {
  it("returns true when active_hours is undefined", () => {
    expect(isActiveNow(undefined)).toBe(true);
    expect(isActiveNow(undefined, new Date())).toBe(true);
  });

  it("returns true at the start boundary (inclusive)", () => {
    expect(isActiveNow(utcCfg, utcDate(8, 0))).toBe(true);
  });

  it("returns true during active window", () => {
    expect(isActiveNow(utcCfg, utcDate(12, 30))).toBe(true);
    expect(isActiveNow(utcCfg, utcDate(22, 59))).toBe(true);
  });

  it("returns false at the end boundary (exclusive)", () => {
    expect(isActiveNow(utcCfg, utcDate(23, 0))).toBe(false);
  });

  it("returns false during quiet hours", () => {
    expect(isActiveNow(utcCfg, utcDate(0, 0))).toBe(false);
    expect(isActiveNow(utcCfg, utcDate(7, 59))).toBe(false);
    expect(isActiveNow(utcCfg, utcDate(23, 30))).toBe(false);
  });

  it("handles overnight window (start > end)", () => {
    const overnight: ActiveHoursConfig = {
      timezone: "UTC",
      start: "22:00",
      end: "06:00",
    };
    // Inside the overnight window
    expect(isActiveNow(overnight, utcDate(22, 0))).toBe(true);
    expect(isActiveNow(overnight, utcDate(23, 59))).toBe(true);
    expect(isActiveNow(overnight, utcDate(0, 0))).toBe(true);
    expect(isActiveNow(overnight, utcDate(5, 59))).toBe(true);
    // Outside the overnight window
    expect(isActiveNow(overnight, utcDate(6, 0))).toBe(false);
    expect(isActiveNow(overnight, utcDate(12, 0))).toBe(false);
    expect(isActiveNow(overnight, utcDate(21, 59))).toBe(false);
  });

  it("treats invalid config as always active", () => {
    const bad: ActiveHoursConfig = { timezone: "UTC", start: "bad", end: "23:00" };
    expect(isActiveNow(bad, utcDate(3, 0))).toBe(true);
  });

  it("falls back to UTC for unknown timezone", () => {
    const cfg: ActiveHoursConfig = {
      timezone: "Not/ATimezone",
      start: "00:00",
      end: "23:59",
    };
    // With UTC fallback, any time in 00:00-23:59 is active
    expect(isActiveNow(cfg, utcDate(12, 0))).toBe(true);
  });
});
