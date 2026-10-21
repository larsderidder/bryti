import crypto from "node:crypto";
import { createWorkStore } from "./store.js";
import { createCommandStore, sameCommandOwner } from "./commands.js";
import { createProjectionStore } from "../projection/store.js";
import type { IncomingMessage } from "../channels/types.js";

/** Read the receipt rather than treating a pending projection as a healthy schedule. */
export function inspectWorkRecovery(dataDir: string, workId: string) {
  const work = createWorkStore(dataDir);
  const commands = createCommandStore(dataDir);
  try {
    const receipt = work.get(workId);
    const recovery = commands.recoveryState(workId, work);
    const reconciled = commands.isReconciled(workId, work);
    let state = "paused";
    if (!receipt) {
      state = "missing_receipt";
    } else if (["queued", "running"].includes(receipt.execution)) {
      state = receipt.execution;
    } else if (reconciled || (receipt.execution === "completed" && recovery.commands.length === 0
      && recovery.blockers.length === 0)) {
      state = "awaiting_settlement";
    }
    return { work_id: workId, state, execution: receipt?.execution, delivery: receipt?.delivery,
      error: receipt?.error, created_at: receipt?.createdAt, updated_at: receipt?.updatedAt, reconciled, ...recovery };
  } finally {
    commands.close();
    work.close();
  }
}

/** An explicit operator review releases future scheduling, never the original execution. */
export function reconcileWorkAsOperator(dataDir: string, userId: string, workId: string, evidence: string): string {
  const work = createWorkStore(dataDir);
  const commands = createCommandStore(dataDir);
  let reviewId: string | undefined;
  try {
    const parent = work.get(workId);
    if (!parent || parent.message.userId !== userId) {
      throw new Error("Work not found for the specified user");
    }
    if (!evidence.trim() || evidence.length > 4000) {
      throw new Error("Provide concise evidence of the reviewed task outcome");
    }
    reviewId = `operator-review:${crypto.randomUUID()}`;
    const review = work.accept({
      userId, channelId: parent.message.channelId, platform: parent.message.platform,
      threadId: parent.message.threadId, channelThreadId: parent.message.channelThreadId,
      workId: reviewId, text: `Operator outcome review for ${workId}: ${evidence}`, raw: null,
    }).record;
    work.claim([review.id]);
    commands.reconcile(workId, review.message, evidence, work);
    work.finish([review.id], "completed");
    return review.id;
  } catch (error) {
    if (reviewId) {
      work.finish([reviewId], "failed", "Operator reconciliation rejected");
    }
    throw error;
  } finally {
    commands.close();
    work.close();
  }
}

/** A delivered command report must not imply that an unreconciled schedule resumed. */
export function commandReviewNotice(dataDir: string, target: IncomingMessage): string {
  const match = /^command:(c-[a-f0-9]{24}):completion$/.exec(target.workId ?? "");
  if (!match) {
    return "";
  }
  const commands = createCommandStore(dataDir);
  const work = createWorkStore(dataDir);
  const projections = createProjectionStore(target.userId, dataDir);
  try {
    const command = commands.get(match[1]);
    if (!command || !sameCommandOwner(command.owner, target)) {
      return "";
    }
    const held = projections.getAwaitingDelivery().some((projection) => {
      const workId = projection.delivery_work_id;
      if (projection.status !== "pending" || !projection.recurrence || !workId || !command.parentWorkIds.includes(workId)) {
        return false;
      }
      const state = commands.recoveryState(workId, work);
      return !commands.isReconciled(workId, work)
        && !(state.review?.id === target.workId && state.blockers.length === 0);
    });
    if (!held) {
      return "";
    }
    return "The recurring schedule is still paused while I finish checking this run.";
  } finally {
    projections.close();
    work.close();
    commands.close();
  }
}
