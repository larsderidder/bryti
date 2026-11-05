import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkStore, type WorkStore } from "./store.js";
import { createWorkRecoveryEvent, getWorkRecoveryReviews, nextWorkRecoveryAttempt, workRecoveryId, workRecoveryParentId } from "./recovery-event.js";

let dir: string;
let work: WorkStore;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T08:00:00Z"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-recovery-attempts-"));
  work = createWorkStore(dir);
});
afterEach(() => {
  work.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function parent() {
  const receipt = work.accept({ userId: "owner", channelId: "chat", platform: "telegram", text: "Check", raw: null }).record;
  work.claim([receipt.id]);
  work.finish([receipt.id], "interrupted");
  return work.get(receipt.id)!;
}

describe("bounded durable recovery attempts", () => {
  it("backs off after failed and unreconciled reviews, caps attempts across restarts", () => {
    const receipt = parent();
    for (const attempt of [1, 2, 3]) {
      expect(nextWorkRecoveryAttempt(work, receipt.id)).toBe(attempt);
      const event = createWorkRecoveryEvent(receipt, "Check", attempt);
      expect(workRecoveryParentId(event)).toBe(receipt.id);
      expect(event.workId).toBe(workRecoveryId(receipt.id, attempt));
      work.accept(event);
      expect(nextWorkRecoveryAttempt(work, receipt.id)).toBeNull();
      work.claim([event.workId!]);
      work.finish([event.workId!], "failed");
      expect(nextWorkRecoveryAttempt(work, receipt.id)).toBeNull();
      vi.setSystemTime(Date.now() + 60 * 60 * 1000);
      work.close();
      work = createWorkStore(dir);
    }
    expect(nextWorkRecoveryAttempt(work, receipt.id)).toBeNull();
    expect(getWorkRecoveryReviews(work, receipt.id)).toHaveLength(3);
    expect(work.get(receipt.id)?.execution).toBe("interrupted");
  });

  it("retains unknown review delivery as a blocker instead of retrying", () => {
    const receipt = parent();
    const event = createWorkRecoveryEvent(receipt, "Check");
    work.accept(event);
    work.claim([event.workId!]);
    work.recordResponse([event.workId!], "unknown");
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    expect(nextWorkRecoveryAttempt(work, receipt.id)).toBeNull();
  });
});
