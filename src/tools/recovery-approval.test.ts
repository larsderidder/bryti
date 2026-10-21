import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "../channels/types.js";
import type { Config } from "../config.js";
import { scheduledWorkId } from "../projection/occurrence.js";
import { createProjectionStore, type ProjectionStore } from "../projection/store.js";
import { createTrustStore, registerToolCapabilities } from "../trust/store.js";
import { wrapToolWithTrustCheck } from "../trust/wrapper.js";
import { createCommandStore, type CommandStore } from "../work/commands.js";
import { EffectStore, wrapEffectTool } from "../work/effects.js";
import { createWorkRecoveryEvent } from "../work/recovery-event.js";
import { createWorkStore, type WorkStore } from "../work/store.js";
import { WorkerStore } from "../workers/store.js";
import { createWorkRecoveryTools } from "./commands.js";

const owner: IncomingMessage = { userId: "u", channelId: "chat", platform: "telegram", threadId: "topic",
  channelThreadId: "7", text: "Check calendar", raw: null };

describe.each(["work-recovery", "recovery"])("automatic recovery approval (%s)", (namespace) => {
  let dir: string;
  let work: WorkStore;
  let commands: CommandStore;
  let projections: ProjectionStore;
  let projectionId: string;
  let parentId: string;
  let target: IncomingMessage;
  const evaluateToolCall = vi.fn();
  const onApprovalNeeded = vi.fn();

  beforeEach(() => {
    evaluateToolCall.mockReset().mockResolvedValue({ verdict: "ASK", reason: "No matching user request" });
    onApprovalNeeded.mockReset().mockResolvedValue("expired");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-recovery-approval-"));
    work = createWorkStore(dir);
    commands = createCommandStore(dir);
    projections = createProjectionStore(owner.userId, dir);
    projectionId = projections.add({ summary: "Calendar", resolution: "exact", resolved_when: "2026-10-20 08:00", recurrence: "0 8 * * *" });
    parentId = scheduledWorkId(owner.userId, projections.getById(projectionId)!);
    const parent = work.accept({ ...owner, workId: parentId, raw: { type: "projection_exact_check" } }).record;
    projections.markDeliveryWork(projectionId, parentId);
    work.claim([parentId]);
    work.finish([parentId], "interrupted");
    const event = createWorkRecoveryEvent(parent, "Calendar");
    if (namespace === "recovery") {
      event.workId = `recovery:${parentId}`;
      event.workIds = [event.workId];
    }
    target = work.accept(event).record.message;
    work.claim(target.workIds!);
    registerToolCapabilities("work_reconcile", { level: "elevated", capabilities: ["filesystem"] });
  });

  afterEach(() => {
    projections.close();
    commands.close();
    work.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function wrappedTool() {
    const tool = createWorkRecoveryTools(dir, () => target)[0];
    return wrapToolWithTrustCheck(wrapEffectTool(tool, dir, () => target), createTrustStore(dir), owner.userId, {
      config: {} as Config,
      getLastUserMessage: () => "Unrelated later message",
      evaluateToolCall,
      onApprovalNeeded,
    });
  }

  it("records a bounded automatic review without a guardrail call, approval, replay or immediate rearming", async () => {
    const result = await wrappedTool().execute("review", { work_id: parentId, evidence: "Read-only check stopped without effects" });
    expect(result.details).toMatchObject({ reconciled: parentId });
    expect(evaluateToolCall).not.toHaveBeenCalled();
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(commands.recoveryState(parentId, work).review?.id).toBe(target.workId);
    expect(commands.isReconciled(parentId, work)).toBe(false);
    work.finish(target.workIds!, "completed");
    expect(commands.isReconciled(parentId, work)).toBe(true);
    expect(work.get(parentId)?.execution).toBe("interrupted");
    expect(projections.getById(projectionId)?.delivery_work_id).toBe(parentId);
    expect(work.queued()).toEqual([]);
  });

  it.each(["unknown effects", "unresolved delivery", "active worker", "active command", "cancelled", "rescheduled", "replaced occurrence", "other work", "empty evidence"])("rejects %s without asking the user to clear the blocker", async (blocker) => {
    let workId = parentId;
    let evidence = "Inspected existing outcomes";
    if (blocker === "unknown effects") {
      const effects = new EffectStore(dir);
      const effect = effects.accept(target, "write", "file_write", { path: "output" }, "implementation").receipt;
      effects.finish(effect.id);
      effects.close();
    } else if (blocker === "unresolved delivery") {
      work.recordResponse([parentId], "unknown");
    } else if (blocker === "active worker") {
      const workers = new WorkerStore(dir);
      workers.accept("identity", { owner: target, task: "Research", toolNames: [], timeoutMs: 1000 }, "test/model");
      workers.close();
    } else if (blocker === "active command") {
      commands.accept(target, "command", { command: "true", cwd: dir, timeoutSeconds: 20 }, 1);
    } else if (blocker === "cancelled") {
      projections.resolve(projectionId, "cancelled");
    } else if (blocker === "rescheduled") {
      projections.rearm(projectionId, "2026-10-21 08:00");
    } else if (blocker === "replaced occurrence") {
      projections.clearDeliveryWork(projectionId, parentId);
    } else if (blocker === "other work") {
      const other = work.accept({ ...owner, text: "Different task" }).record;
      work.claim([other.id]);
      work.finish([other.id], "interrupted");
      workId = other.id;
    } else if (blocker === "empty evidence") {
      evidence = " ";
    }
    const result = await wrappedTool().execute("review", { work_id: workId, evidence });
    expect(result.details).toHaveProperty("error");
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(evaluateToolCall).not.toHaveBeenCalled();
    expect(commands.recoveryState(workId, work).review).toBeNull();
  });

  it.each(["human review", "command completion", "forged event", "wrong topic", "finished review"])("retains the guardrail for %s", async (kind) => {
    if (kind === "human review" || kind === "command completion") {
      let raw: IncomingMessage["raw"] = null;
      if (kind === "command completion") {
        raw = { type: "command_completion" };
      }
      target = work.accept({ ...owner, text: "Review", raw }).record.message;
      work.claim(target.workIds!);
    } else if (kind === "forged event") {
      const human = work.accept({ ...owner, text: "Not a recovery event" }).record;
      work.claim([human.id]);
      target = { ...human.message, raw: { type: "work_recovery" } };
    } else if (kind === "wrong topic") {
      target = { ...target, channelThreadId: "8" };
    } else if (kind === "finished review") {
      work.finish(target.workIds!, "completed");
    }
    await wrappedTool().execute("review", { work_id: parentId, evidence: "Checked" });
    expect(evaluateToolCall).toHaveBeenCalledOnce();
    expect(onApprovalNeeded).toHaveBeenCalledOnce();
    expect(commands.recoveryState(parentId, work).review).toBeNull();
  });

  it("does not grant an unrelated implementation the built-in tool's authority", async () => {
    const builtin = createWorkRecoveryTools(dir, () => target)[0];
    const execute = vi.fn();
    const replacement = wrapToolWithTrustCheck({ ...builtin, execute }, createTrustStore(dir), owner.userId, {
      config: {} as Config, getLastUserMessage: () => "Status", evaluateToolCall, onApprovalNeeded,
    });
    await replacement.execute("review", { work_id: parentId, evidence: "Checked" });
    expect(onApprovalNeeded).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("checks the current durable event on every call instead of caching automatic authority", async () => {
    const recovery = target;
    target = work.accept({ ...owner, text: "Review this task" }).record.message;
    work.claim(target.workIds!);
    const human = target;
    const tool = wrappedTool();
    target = recovery;
    await tool.execute("automatic", { work_id: parentId, evidence: "Checked the stopped run" });
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(commands.recoveryState(parentId, work).review?.id).toBe(recovery.workId);
    target = human;
    await tool.execute("human", { work_id: parentId, evidence: "Another review" });
    expect(evaluateToolCall).toHaveBeenCalledOnce();
    expect(onApprovalNeeded).toHaveBeenCalledOnce();
    expect(commands.recoveryState(parentId, work).review?.id).toBe(recovery.workId);
  });

  it("does not record reconciliation after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await wrappedTool().execute("review", { work_id: parentId, evidence: "Checked" }, controller.signal);
    expect(onApprovalNeeded).not.toHaveBeenCalled();
    expect(commands.recoveryState(parentId, work).review).toBeNull();
  });
});
