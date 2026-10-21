import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkStore, type WorkStore } from "./store.js";
import { createCommandStore, isWorkRecoveryCurrent } from "./commands.js";
import { EffectStore } from "./effects.js";
import { WorkerStore } from "../workers/store.js";
import { inspectWorkRecovery, reconcileWorkAsOperator, commandReviewNotice } from "./recovery.js";
import { createWorkRecoveryTools } from "../tools/commands.js";
import type { IncomingMessage } from "../channels/types.js";
import { createProjectionStore } from "../projection/store.js";
import { scheduledWorkId } from "../projection/occurrence.js";
import { createWorkRecoveryEvent } from "./recovery-event.js";
const owner: IncomingMessage = { userId: "u", channelId: "chat", platform: "telegram", threadId: "topic",
  channelThreadId: "7", text: "Inspect calendar", raw: null };

describe("work recovery", () => {
  let dir: string;
  let work: WorkStore;
  let parent: IncomingMessage;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-work-recovery-"));
    work = createWorkStore(dir);
    parent = work.accept(owner).record.message;
    work.claim(parent.workIds!);
  });

  afterEach(() => {
    work.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records an operator review without a model, replay or changes to old outcomes", () => {
    work.finish(parent.workIds!, "failed", "Input exceeds the message limit");
    expect(inspectWorkRecovery(dir, parent.workId!).state).toBe("paused");
    const id = reconcileWorkAsOperator(dir, "u", parent.workId!, "Input rejected before execution; no actions ran");
    expect(work.get(id)).toMatchObject({ execution: "completed", delivery: "none", message: {
      userId: "u", threadId: "topic", channelThreadId: "7",
    } });
    expect(inspectWorkRecovery(dir, parent.workId!)).toMatchObject({ state: "awaiting_settlement", reconciled: true });
    expect(work.get(parent.workId!)).toMatchObject({ execution: "failed", error: "Input exceeds the message limit" });
    expect(work.queued()).toEqual([]);
  });

  it("rejects operator reviews without evidence or for the wrong user", () => {
    work.finish(parent.workIds!, "interrupted");
    expect(() => reconcileWorkAsOperator(dir, "other", parent.workId!, "Checked")).toThrow(/user/i);
    expect(() => reconcileWorkAsOperator(dir, "u", parent.workId!, " ")).toThrow(/evidence/i);
    expect(inspectWorkRecovery(dir, parent.workId!).reconciled).toBe(false);
  });

  it.each(["running", "unknown"])("cannot hide %s effects behind a successful review", (state) => {
    const effects = new EffectStore(dir);
    try {
      const effect = effects.accept(parent, "write", "file_write", { path: "output" }, "implementation").receipt;
      if (state === "unknown") {
        effects.finish(effect.id);
      }
      work.finish(parent.workIds!, "interrupted");
      expect(() => reconcileWorkAsOperator(dir, "u", parent.workId!, "Checked")).toThrow(/effects.*unknown/i);
      expect(inspectWorkRecovery(dir, parent.workId!).reconciled).toBe(false);
    } finally {
      effects.close();
    }
  });

  it("waits for active workers even when the parent turn has ended", () => {
    const workers = new WorkerStore(dir);
    try {
      const worker = workers.accept("identity", { owner: parent, task: "Read-only research", toolNames: [], timeoutMs: 1000 }, "test/model");
      work.finish(parent.workIds!, "interrupted");
      expect(() => reconcileWorkAsOperator(dir, "u", parent.workId!, "Checked")).toThrow(/worker.*active/i);
      workers.finish(worker.workerId, "cancelled");
      reconcileWorkAsOperator(dir, "u", parent.workId!, "Worker cancelled before starting; no external effects");
      expect(inspectWorkRecovery(dir, parent.workId!).reconciled).toBe(true);
    } finally {
      workers.close();
    }
  });

  it.each(["pending", "unknown", "failed"] as const)("cannot clear %s original delivery", (delivery) => {
    work.recordResponse(parent.workIds!, delivery);
    expect(() => reconcileWorkAsOperator(dir, "u", parent.workId!, "Checked")).toThrow(/delivery/i);
  });

  it("does not consider delivered managed work healthy before reconciliation", () => {
    const commands = createCommandStore(dir);
    try {
      const command = commands.accept(parent, "call", { command: "true", cwd: dir, timeoutSeconds: 1 }, 1);
      commands.finish(command.id, "complete", 0);
      work.recordResponse(parent.workIds!, "delivered");
      expect(inspectWorkRecovery(dir, parent.workId!)).toMatchObject({ state: "paused", reconciled: false });
    } finally {
      commands.close();
    }
  });

  it("labels unreconciled completion reports instead of implying their schedule resumed", () => {
    const projections = createProjectionStore("u", dir);
    const commands = createCommandStore(dir);
    try {
      const id = projections.add({ summary: "Health", resolution: "exact", resolved_when: "2026-10-11 07:30", recurrence: "30 9 * * *" });
      const workId = scheduledWorkId("u", projections.getById(id)!);
      const scheduled = work.accept({ ...owner, workId, raw: { type: "projection_exact_check" } }).record;
      projections.markDeliveryWork(id, workId);
      work.claim([workId]);
      const command = commands.accept(scheduled.message, "health", { command: "true", cwd: dir, timeoutSeconds: 1 }, 1);
      commands.finish(command.id, "complete", 0);
      work.recordResponse([workId], "delivered");
      const review = work.accept(commands.collectEvents()[0]).record;
      work.claim([review.id]);
      expect(commandReviewNotice(dir, review.message)).toBe("The recurring schedule is still paused while I finish checking this run.");
      commands.reconcile(workId, review.message, "Inspected the whole task, including output and effects", work);
      expect(commandReviewNotice(dir, review.message)).toBe("");
      work.recordResponse([review.id], "delivered");
      expect(commandReviewNotice(dir, review.message)).toBe("");
    } finally {
      commands.close();
      projections.close();
    }
  });

  it("does not let an interrupted review's unknown effect release its parent", () => {
    work.finish(parent.workIds!, "interrupted");
    const review = work.accept({ ...owner, text: "Review and preserve partial work" }).record;
    work.claim([review.id]);
    const commands = createCommandStore(dir);
    const effects = new EffectStore(dir);
    try {
      commands.reconcile(parent.workId!, review.message, "Inspected original run", work);
      effects.accept(review.message, "write", "file_write", { path: "review-output" }, "implementation");
      work.recordResponse([review.id], "delivered");
      expect(commands.isReconciled(parent.workId!, work)).toBe(false);
      expect(inspectWorkRecovery(dir, parent.workId!).blockers).toContainEqual(expect.stringContaining("effects"));
    } finally {
      effects.close();
      commands.close();
    }
  });

  function scheduledRecovery() {
    const projections = createProjectionStore("u", dir);
    try {
      const id = projections.add({ summary: "Calendar", resolution: "exact", resolved_when: "2026-10-20 08:00", recurrence: "0 10 * * *" });
      const workId = scheduledWorkId("u", projections.getById(id)!);
      const original = work.accept({ ...owner, workId, raw: { type: "projection_exact_check" } }).record;
      projections.markDeliveryWork(id, workId);
      work.claim([workId]);
      work.finish([workId], "interrupted");
      const review = work.accept(createWorkRecoveryEvent(original, "Calendar")).record;
      work.claim([review.id]);
      return { id, original, review };
    } finally {
      projections.close();
    }
  }

  it("allows only the bound automatic review and waits for its successful settlement", () => {
    const { original, review } = scheduledRecovery();
    const commands = createCommandStore(dir);
    try {
      expect(review.message.raw).toEqual({ type: "work_recovery" });
      expect(isWorkRecoveryCurrent(dir, review.message, work)).toBe(true);
      expect(() => commands.reconcile(parent.workId!, review.message, "Different occurrence", work)).toThrow(/review/i);
      commands.reconcile(original.id, review.message, "Inspected stopped read-only checks, no external effects", work);
      expect(commands.isReconciled(original.id, work)).toBe(false);
      work.finish([review.id], "completed");
      expect(commands.isReconciled(original.id, work)).toBe(true);
      expect(isWorkRecoveryCurrent(dir, review.message, work)).toBe(false);
      expect(work.get(original.id)?.execution).toBe("interrupted");
    } finally {
      commands.close();
    }
  });

  it.each(["cancelled", "rearmed"])("rejects a queued recovery after its projection is %s", (change) => {
    const { id, original, review } = scheduledRecovery();
    const projections = createProjectionStore("u", dir);
    const commands = createCommandStore(dir);
    try {
      if (change === "cancelled") {
        projections.resolve(id, "cancelled");
      } else {
        projections.rearm(id, "2026-10-21 08:00");
      }
      expect(isWorkRecoveryCurrent(dir, review.message, work)).toBe(false);
      expect(() => commands.reconcile(original.id, review.message, "Stale review", work)).toThrow(/review/i);
    } finally {
      projections.close();
      commands.close();
    }
  });

  it("tracks unknown effects from an automatic review even if it failed before recording reconciliation", () => {
    const { original, review } = scheduledRecovery();
    const effects = new EffectStore(dir);
    try {
      const effect = effects.accept(review.message, "write", "file_write", { path: "output" }, "implementation").receipt;
      effects.finish(effect.id);
      work.finish([review.id], "failed");
      expect(inspectWorkRecovery(dir, original.id).blockers).toContainEqual(expect.stringContaining("effects"));
      expect(() => reconcileWorkAsOperator(dir, "u", original.id, "Checked original run")).toThrow(/effects.*unknown/i);
    } finally {
      effects.close();
    }
  });

  it("keeps failed recovery reviews unresolved even after work_reconcile returned", () => {
    const { original, review } = scheduledRecovery();
    const commands = createCommandStore(dir);
    try {
      commands.reconcile(original.id, review.message, "Inspected original outcome", work);
      work.finish([review.id], "failed");
      expect(commands.isReconciled(original.id, work)).toBe(false);
    } finally {
      commands.close();
    }
  });

  it.each(["pending", "unknown", "failed"] as const)("does not let automated review clear %s original delivery", (delivery) => {
    const { original, review } = scheduledRecovery();
    const commands = createCommandStore(dir);
    try {
      work.recordDelivery([original.id], delivery);
      expect(() => commands.reconcile(original.id, review.message, "Checked", work)).toThrow(/delivery/i);
    } finally {
      commands.close();
    }
  });

  it("pages original requests and protects work inspection across owners and topics", async () => {
    const record = work.accept({ ...owner, text: "original constraints ".repeat(1000) }).record;
    let target = owner;
    work.claim([record.id]);
    const report = "Release verified, but token rotation needs user approval. ".repeat(300);
    work.stageResponse(record.message, report);
    work.recordResponse([record.id], "delivered");
    const tools = createWorkRecoveryTools(dir, () => target);
    const inspect = tools.find((tool) => tool.name === "work_inspect")!;
    const first = await inspect.execute("inspect", { work_id: record.id });
    expect(first.details).toMatchObject({ request: { offset: 0, next_offset: 8000, text: record.message.text.slice(0, 8000) } });
    const next = await inspect.execute("inspect", { work_id: record.id, request_offset: 8000 });
    expect(next.details).toMatchObject({ request: { text: record.message.text.slice(8000, 16000) } });
    expect(first.details).toMatchObject({ response: { text: report.slice(0, 8000), next_offset: 8000, delivery: "delivered" } });
    const responsePage = await inspect.execute("inspect", { work_id: record.id, response_offset: 8000 });
    expect(responsePage.details).toMatchObject({ response: { text: report.slice(8000, 16000), offset: 8000, next_offset: 16000 } });
    for (const changed of [{ userId: "other" }, { platform: "whatsapp" as const }, { channelId: "other" },
      { threadId: "other" }, { channelThreadId: "8" }]) {
      target = { ...owner, ...changed };
      expect((await inspect.execute("inspect", { work_id: record.id })).details).toHaveProperty("error");
    }
  });
});
