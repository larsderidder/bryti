import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getUserTimezone,
  formatLocal,
  formatUtc,
  currentTimePromptLine,
  toUtc,
  toLocal,
} from "./time.js";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Minimal config stub
// ---------------------------------------------------------------------------

function makeConfig(timezone?: string): Config {
  return {
    agent: {
      name: "test",
      system_prompt: "",
      model: "p/m",
      fallback_models: [],
      timezone,
    },
    telegram: { token: "", allowed_users: [] },
    whatsapp: { enabled: false },
    models: { providers: [] },
    tools: {
      web_search: { enabled: false, api_key: "" },
      fetch_url: { enabled: false, timeout_ms: 10000 },
      files: { enabled: false, base_dir: "" },
    },
    cron: [],
    data_dir: "/tmp",
    active_hours: undefined as any,
  };
}

// ---------------------------------------------------------------------------
// getUserTimezone
// ---------------------------------------------------------------------------

describe("getUserTimezone", () => {
  it("returns UTC when no timezone configured", () => {
    expect(getUserTimezone(makeConfig())).toBe("UTC");
  });

  it("returns the configured IANA string", () => {
    expect(getUserTimezone(makeConfig("Europe/Amsterdam"))).toBe("Europe/Amsterdam");
  });

  it("returns UTC for empty string", () => {
    expect(getUserTimezone(makeConfig(""))).toBe("UTC");
  });
});

// ---------------------------------------------------------------------------
// formatLocal / formatUtc
// ---------------------------------------------------------------------------

describe("formatLocal", () => {
  it("formats a Date in a given timezone", () => {
    // 2026-01-15 12:00 UTC = 13:00 CET (UTC+1, no DST in January)
    const d = new Date("2026-01-15T12:00:00Z");
    expect(formatLocal(d, "Europe/Amsterdam")).toBe("2026-01-15 13:00");
  });

  it("handles DST transition - summer time (UTC+2)", () => {
    // 2026-07-15 12:00 UTC = 14:00 CEST (UTC+2, DST)
    const d = new Date("2026-07-15T12:00:00Z");
    expect(formatLocal(d, "Europe/Amsterdam")).toBe("2026-07-15 14:00");
  });

  it("formats in UTC", () => {
    const d = new Date("2026-03-20T09:30:00Z");
    expect(formatLocal(d, "UTC")).toBe("2026-03-20 09:30");
  });

  it("formats in a US timezone", () => {
    // 2026-01-15 18:00 UTC = 13:00 EST (UTC-5)
    const d = new Date("2026-01-15T18:00:00Z");
    expect(formatLocal(d, "America/New_York")).toBe("2026-01-15 13:00");
  });
});

describe("formatUtc", () => {
  it("returns UTC string with ' UTC' suffix", () => {
    const d = new Date("2026-02-18T10:30:00Z");
    expect(formatUtc(d)).toBe("2026-02-18 10:30 UTC");
  });
});

// ---------------------------------------------------------------------------
// currentTimePromptLine
// ---------------------------------------------------------------------------

describe("currentTimePromptLine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows only UTC when timezone is UTC", () => {
    vi.useFakeTimers({ now: new Date("2026-02-18T10:30:00Z") });
    const line = currentTimePromptLine("UTC");
    expect(line).toBe("2026-02-18 10:30 UTC");
  });

  it("shows local + UTC when timezone differs from UTC", () => {
    // 10:30 UTC = 11:30 CET (UTC+1 in February)
    vi.useFakeTimers({ now: new Date("2026-02-18T10:30:00Z") });
    const line = currentTimePromptLine("Europe/Amsterdam");
    expect(line).toBe("2026-02-18 11:30 (Europe/Amsterdam) / 2026-02-18 10:30 UTC");
  });
});

// ---------------------------------------------------------------------------
// toUtc
// ---------------------------------------------------------------------------

describe("toUtc", () => {
  it("converts a naive local time to UTC (UTC+1)", () => {
    // 10:00 local CET = 09:00 UTC
    expect(toUtc("2026-02-18 10:00", "Europe/Amsterdam")).toBe("2026-02-18 09:00");
  });

  it("converts a naive local time to UTC (UTC+2, DST)", () => {
    // 14:00 local CEST = 12:00 UTC
    expect(toUtc("2026-07-15 14:00", "Europe/Amsterdam")).toBe("2026-07-15 12:00");
  });

  it("handles T separator", () => {
    expect(toUtc("2026-02-18T10:00", "Europe/Amsterdam")).toBe("2026-02-18 09:00");
  });

  it("returns date-only strings unchanged", () => {
    expect(toUtc("2026-02-18", "Europe/Amsterdam")).toBe("2026-02-18");
  });

  it("passes through inputs that already have Z offset", () => {
    expect(toUtc("2026-02-18T10:00Z", "Europe/Amsterdam")).toBe("2026-02-18 10:00");
  });

  it("passes through inputs with explicit +HH:MM offset", () => {
    expect(toUtc("2026-02-18T10:00+01:00", "Europe/Amsterdam")).toBe("2026-02-18 09:00");
  });

  it("works for UTC timezone (no-op)", () => {
    expect(toUtc("2026-02-18 10:00", "UTC")).toBe("2026-02-18 10:00");
  });

  it("handles US eastern standard time (UTC-5)", () => {
    // 08:00 EST = 13:00 UTC
    expect(toUtc("2026-01-15 08:00", "America/New_York")).toBe("2026-01-15 13:00");
  });

  it("handles DST transition correctly for Amsterdam", () => {
    // Winter: 08:00 CET (UTC+1) = 07:00 UTC
    expect(toUtc("2026-01-15 08:00", "Europe/Amsterdam")).toBe("2026-01-15 07:00");
    // Summer: 08:00 CEST (UTC+2) = 06:00 UTC
    expect(toUtc("2026-07-15 08:00", "Europe/Amsterdam")).toBe("2026-07-15 06:00");
  });

  // DST spring-forward edge case for Amsterdam
  // On last Sunday of March, clocks jump from 02:00 to 03:00 (CET -> CEST)
  it("handles the spring-forward hour for Amsterdam", () => {
    // 2026-03-29 02:30 does not exist in Amsterdam; toUtc should not crash
    // and should return a plausible UTC value (2026-03-29 01:30 UTC = 02:30 CET)
    const result = toUtc("2026-03-29 02:30", "Europe/Amsterdam");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// toLocal
// ---------------------------------------------------------------------------

describe("toLocal", () => {
  it("converts a UTC datetime to local time", () => {
    // 09:00 UTC = 10:00 CET (UTC+1)
    expect(toLocal("2026-02-18 09:00", "Europe/Amsterdam")).toBe("2026-02-18 10:00");
  });

  it("returns date-only strings unchanged", () => {
    expect(toLocal("2026-02-18", "Europe/Amsterdam")).toBe("2026-02-18");
  });

  it("works for UTC timezone (no-op)", () => {
    expect(toLocal("2026-02-18 10:00", "UTC")).toBe("2026-02-18 10:00");
  });
});
