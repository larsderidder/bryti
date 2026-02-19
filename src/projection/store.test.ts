import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createProjectionStore,
  formatProjectionsForPrompt,
  type ProjectionStore,
  type Projection,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibot-proj-test-"));
}

function isoHoursFromNow(hours: number): string {
  const d = new Date(Date.now() + hours * 3600 * 1000);
  // Use SQLite datetime format: "YYYY-MM-DD HH:MM" (space, not T)
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function isoDateFromNow(days: number): string {
  const d = new Date(Date.now() + days * 86400 * 1000);
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createProjectionStore", () => {
  let tempDir: string;
  let store: ProjectionStore;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = createProjectionStore("user1", tempDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds a projection and returns an id", () => {
    const id = store.add({ summary: "Dentist appointment" });
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("retrieves upcoming projections within the horizon", () => {
    store.add({
      summary: "Doctor tomorrow",
      resolved_when: isoDateFromNow(1),
      resolution: "day",
    });
    store.add({
      summary: "Far-future thing",
      resolved_when: isoDateFromNow(30),
      resolution: "day",
    });

    const upcoming = store.getUpcoming(7);
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].summary).toBe("Doctor tomorrow");
  });

  it("always includes someday projections", () => {
    store.add({ summary: "Learn piano", resolution: "someday" });
    const upcoming = store.getUpcoming(0);
    expect(upcoming.some((p) => p.summary === "Learn piano")).toBe(true);
  });

  it("includes projections with no resolved_when", () => {
    store.add({ summary: "Vague future thing" });
    const upcoming = store.getUpcoming(7);
    expect(upcoming.some((p) => p.summary === "Vague future thing")).toBe(true);
  });

  it("resolves a projection as done", () => {
    const id = store.add({ summary: "Buy groceries" });
    const ok = store.resolve(id, "done");
    expect(ok).toBe(true);

    // Should not appear in upcoming anymore
    const upcoming = store.getUpcoming(30);
    expect(upcoming.find((p) => p.id === id)).toBeUndefined();
  });

  it("returns false when resolving a non-existent id", () => {
    const ok = store.resolve("non-existent-id", "done");
    expect(ok).toBe(false);
  });

  it("does not resolve an already-resolved projection", () => {
    const id = store.add({ summary: "Already done thing" });
    store.resolve(id, "done");
    const ok = store.resolve(id, "cancelled");
    expect(ok).toBe(false);
  });

  it("stores linked_ids as an array", () => {
    const id1 = store.add({ summary: "Parent event" });
    const id2 = store.add({ summary: "Child event", linked_ids: [id1] });

    const upcoming = store.getUpcoming(30);
    const child = upcoming.find((p) => p.id === id2);
    expect(child).toBeDefined();
    expect(child!.linked_ids).toEqual([id1]);
  });

  it("getExactDue returns projections due within window", () => {
    // Due in 30 minutes (within 60-minute window)
    store.add({
      summary: "Dentist in 30 min",
      resolved_when: isoHoursFromNow(0.5),
      resolution: "exact",
    });
    // Due in 2 hours (outside 60-minute window)
    store.add({
      summary: "Meeting later",
      resolved_when: isoHoursFromNow(2),
      resolution: "exact",
    });
    // Day-resolution (excluded from exact check)
    store.add({
      summary: "Day event",
      resolved_when: isoDateFromNow(0),
      resolution: "day",
    });

    const due = store.getExactDue(60);
    expect(due).toHaveLength(1);
    expect(due[0].summary).toBe("Dentist in 30 min");
  });

  it("autoExpire marks old projections as passed", () => {
    // Simulate a projection that expired 48 hours ago by inserting directly
    // with a resolved_when 48 hours in the past. We test via the public interface.
    // Add a projection with resolved_when 48 hours ago.
    const pastDate = new Date(Date.now() - 48 * 3600 * 1000).toISOString().slice(0, 16);
    const id = store.add({
      summary: "Expired event",
      resolved_when: pastDate,
      resolution: "day",
    });

    const count = store.autoExpire(24);
    expect(count).toBeGreaterThan(0);

    // Should not appear in upcoming
    const upcoming = store.getUpcoming(30);
    expect(upcoming.find((p) => p.id === id)).toBeUndefined();
  });

  it("autoExpire does not affect someday projections", () => {
    const id = store.add({ summary: "Someday piano", resolution: "someday" });
    store.autoExpire(0); // Expire everything older than 0 hours
    const upcoming = store.getUpcoming(30);
    expect(upcoming.find((p) => p.id === id)).toBeDefined();
  });

  it("stores and retrieves a recurrence expression", () => {
    const id = store.add({
      summary: "Weekly standup",
      resolved_when: isoHoursFromNow(1),
      resolution: "exact",
      recurrence: "0 9 * * 1",
    });
    const upcoming = store.getUpcoming(30);
    const p = upcoming.find((p) => p.id === id);
    expect(p).toBeDefined();
    expect(p!.recurrence).toBe("0 9 * * 1");
  });

  it("rearm resets a projection to pending with new resolved_when", () => {
    const id = store.add({
      summary: "Weekly review",
      resolved_when: isoHoursFromNow(0.1),
      resolution: "exact",
      recurrence: "0 9 * * 5",
    });

    const newWhen = isoHoursFromNow(168); // 1 week from now
    const ok = store.rearm(id, newWhen);
    expect(ok).toBe(true);

    const upcoming = store.getUpcoming(200);
    const p = upcoming.find((p) => p.id === id);
    expect(p).toBeDefined();
    expect(p!.status).toBe("pending");
    expect(p!.resolved_when).toBe(newWhen);
    expect(p!.recurrence).toBe("0 9 * * 5");
  });

  it("rearm returns false for non-existent id", () => {
    const ok = store.rearm("no-such-id", isoHoursFromNow(24));
    expect(ok).toBe(false);
  });

  it("non-recurring projections have null recurrence", () => {
    const id = store.add({ summary: "One-off thing", resolved_when: isoHoursFromNow(2), resolution: "exact" });
    const upcoming = store.getUpcoming(30);
    const p = upcoming.find((p) => p.id === id);
    expect(p).toBeDefined();
    expect(p!.recurrence).toBeNull();
  });

  it("activates dependent projections when status_change condition is met", () => {
    const subjectId = store.add({ summary: "Client call", resolution: "day", resolved_when: isoDateFromNow(1) });
    const observerId = store.add({
      summary: "Send follow-up email",
      resolution: "day",
      resolved_when: isoDateFromNow(7),
      depends_on: [{ subject_id: subjectId, condition: "done" }],
    });

    expect(store.evaluateDependencies()).toBe(0);

    store.resolve(subjectId, "done");
    expect(store.evaluateDependencies()).toBe(1);

    const upcoming = store.getUpcoming(30);
    const observer = upcoming.find((p) => p.id === observerId);
    expect(observer).toBeDefined();
    expect(observer!.resolution).toBe("exact");
    expect(observer!.resolved_when).toBeTruthy();
    expect(store.getDependencies(observerId)).toEqual([]);
  });

  it("supports chained dependencies", () => {
    const a = store.add({ summary: "A" });
    const b = store.add({ summary: "B", depends_on: [{ subject_id: a, condition: "done" }] });
    const c = store.add({ summary: "C", depends_on: [{ subject_id: b, condition: "done" }] });

    store.resolve(a, "done");
    expect(store.evaluateDependencies()).toBe(1); // activates B
    expect(store.getDependencies(c)).toHaveLength(1);

    store.resolve(b, "done");
    expect(store.evaluateDependencies()).toBe(1); // activates C
  });

  it("rejects dependency cycles", () => {
    const a = store.add({ summary: "A" });
    const b = store.add({ summary: "B", depends_on: [{ subject_id: a, condition: "done" }] });

    expect(() => store.linkDependency(a, b, "done")).toThrow(/cycle/i);
  });

  it("rejects dependency chains deeper than 5", () => {
    const a = store.add({ summary: "A" });
    const b = store.add({ summary: "B" });
    const c = store.add({ summary: "C" });
    const d = store.add({ summary: "D" });
    const e = store.add({ summary: "E" });
    const f = store.add({ summary: "F" });

    store.linkDependency(b, a, "done");
    store.linkDependency(c, b, "done");
    store.linkDependency(d, c, "done");
    store.linkDependency(e, d, "done");

    expect(() => store.linkDependency(f, e, "done")).toThrow(/max 5/i);
  });
});

// ---------------------------------------------------------------------------
// formatProjectionsForPrompt
// ---------------------------------------------------------------------------

describe("formatProjectionsForPrompt", () => {
  it("returns placeholder for empty list", () => {
    const result = formatProjectionsForPrompt([]);
    expect(result).toBe("No upcoming projections.");
  });

  it("formats a projection with resolved_when", () => {
    const p: Projection = {
      id: "abc123",
      summary: "Dentist",
      raw_when: "tomorrow at 10",
      resolved_when: "2026-02-19 10:00",
      resolution: "exact",
      recurrence: null,
      context: "bring insurance card",
      linked_ids: [],
      status: "pending",
      created_at: new Date().toISOString(),
      resolved_at: null,
    };
    const result = formatProjectionsForPrompt([p]);
    expect(result).toContain("Dentist");
    expect(result).toContain("2026-02-19 10:00");
    expect(result).toContain("bring insurance card");
    expect(result).toContain("abc123");
  });

  it("formats recurrence in the projection line", () => {
    const p: Projection = {
      id: "rec1",
      summary: "Weekly standup",
      raw_when: null,
      resolved_when: "2026-02-23 09:00",
      resolution: "exact",
      recurrence: "0 9 * * 1",
      context: null,
      linked_ids: [],
      status: "pending",
      created_at: new Date().toISOString(),
      resolved_at: null,
    };
    const result = formatProjectionsForPrompt([p]);
    expect(result).toContain("recurring: 0 9 * * 1");
  });

  it("falls back to raw_when when no resolved_when", () => {
    const p: Projection = {
      id: "xyz",
      summary: "Shopping",
      raw_when: "next week",
      resolved_when: null,
      resolution: "week",
      recurrence: null,
      context: null,
      linked_ids: [],
      status: "pending",
      created_at: new Date().toISOString(),
      resolved_at: null,
    };
    const result = formatProjectionsForPrompt([p]);
    expect(result).toContain("next week");
  });

  it("caps output at maxItems and shows overflow notice", () => {
    const projections: Projection[] = Array.from({ length: 20 }, (_, i) => ({
      id: `id-${i}`,
      summary: `Event ${i}`,
      raw_when: null,
      resolved_when: null,
      resolution: "day" as const,
      recurrence: null,
      context: null,
      linked_ids: [],
      status: "pending" as const,
      created_at: new Date().toISOString(),
      resolved_at: null,
    }));

    const result = formatProjectionsForPrompt(projections, 15);
    const lines = result.split("\n").filter((l) => l.startsWith("-"));
    expect(lines).toHaveLength(15);
    expect(result).toContain("5 more");
  });
});
