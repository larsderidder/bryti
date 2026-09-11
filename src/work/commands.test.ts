import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkStore, type WorkStore } from "./store.js";
import { createCommandStore, recoverCommandEvents, type CommandStore } from "./commands.js";
import type { IncomingMessage } from "../channels/types.js";

const target: IncomingMessage = { userId: "u1", channelId: "chat", threadId: "topic", channelThreadId: "7", platform: "telegram", text: "develop", raw: null };

describe("managed commands", () => {
  let dir: string;
  let commands: CommandStore;
  let work: WorkStore;
  let parent: IncomingMessage;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-commands-"));
    work = createWorkStore(dir);
    commands = createCommandStore(dir);
    parent = work.accept(target).record.message;
    work.claim(parent.workIds!);
  });
  afterEach(() => {
    commands.close();
    work.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function start(callId = "call1") {
    return commands.accept(parent, callId, { command: "printf done", cwd: dir, timeoutSeconds: 60 }, 2);
  }

  function finish(id: string) {
    expect(commands.claim(id, process.pid, "identity")).toBe(true);
    commands.finish(id, "complete", 0);
  }

  it("deduplicates a tool call and claims it only once", () => {
    const first = start();
    expect(start().id).toBe(first.id);
    expect(commands.claim(first.id, process.pid, "identity")).toBe(true);
    expect(commands.claim(first.id, process.pid, "identity")).toBe(false);
    commands.finish(first.id, "complete", 0);
    commands.finish(first.id, "failed", 1);
    expect(commands.get(first.id)?.status).toBe("complete");
  });

  it("bounds concurrency across sessions and survives reopening", () => {
    start();
    start("call2");
    commands.close();
    commands = createCommandStore(dir);
    expect(() => start("call3")).toThrow(/concurrency/i);
    expect(commands.forWork(parent.workId!)).toHaveLength(2);
  });

  it("does not replay commands when recovering a stopped runner", () => {
    const command = start();
    commands.claim(command.id, 99999, "gone");
    const events = commands.collectEvents(() => false);
    expect(commands.get(command.id)?.status).toBe("interrupted");
    expect(events).toHaveLength(1);
    expect(events[0].text).toContain("Do not rerun");
    expect(commands.claim(command.id, process.pid, "identity")).toBe(false);
    expect(commands.collectEvents(() => false)[0].workId).toBe(events[0].workId);
  });

  it("preserves a live command after parent interruption or restart", () => {
    const command = start();
    commands.claim(command.id, process.pid, "identity");
    work.finish(parent.workIds!, "interrupted");
    work.recover();
    expect(commands.collectEvents(() => true)).toEqual([]);
    expect(commands.get(command.id)?.status).toBe("running");
  });

  it("queues a review, not a replay, after completion and keeps the owning topic", () => {
    const command = start();
    finish(command.id);
    const event = commands.collectEvents()[0];
    expect(event).toMatchObject({ userId: "u1", channelThreadId: "7", threadId: "topic", raw: { type: "command_completion" } });
    expect(event.text).toContain("untrusted");
    expect(event.text).toContain("work_reconcile");
    work.accept(event);
    commands.acknowledge(command.id);
    expect(commands.collectEvents()).toEqual([]);
  });

  it("enqueues completion once and retains rejected or unauthorized notifications", () => {
    const command = start();
    finish(command.id);
    let accepted = 0;
    const enqueue = (event: IncomingMessage) => {
      accepted++;
      work.accept(event);
      return true;
    };
    recoverCommandEvents(dir, work, enqueue, () => false);
    expect(accepted).toBe(0);
    recoverCommandEvents(dir, work, () => false, () => true);
    expect(commands.collectEvents()).toHaveLength(1);
    recoverCommandEvents(dir, work, enqueue, () => true);
    recoverCommandEvents(dir, work, enqueue, () => true);
    expect(accepted).toBe(1);
    expect(commands.collectEvents()).toHaveLength(0);
    expect(work.queued()[0].message.raw).toEqual({ type: "command_completion" });
  });

  it("requires explicit reconciliation of all commands and a successful review receipt", () => {
    const first = start();
    const second = start("call2");
    finish(first.id);
    work.finish(parent.workIds!, "interrupted");
    const review = work.accept(commands.collectEvents()[0]).record;
    work.claim([review.id]);
    expect(() => commands.reconcile(parent.workId!, review.message, "Reviewed logs and diff", work)).toThrow(/still active/i);
    finish(second.id);
    commands.reconcile(parent.workId!, review.message, "Reviewed logs and diff; no deployment occurred", work);
    expect(commands.isReconciled(parent.workId!, work)).toBe(false);
    work.recordResponse([review.id], "delivered");
    expect(commands.isReconciled(parent.workId!, work)).toBe(true);
  });

  it("rejects cross-user and cross-topic reconciliation", () => {
    const command = start();
    finish(command.id);
    for (const changed of [{ userId: "u2" }, { threadId: "other" }, { channelThreadId: "8" }]) {
      const review = work.accept({ ...target, ...changed }).record;
      work.claim([review.id]);
      expect(() => commands.reconcile(parent.workId!, review.message, "Reviewed", work)).toThrow(/owner/i);
    }
  });

  it("keeps unknown original delivery blocked even after review", () => {
    const command = start();
    finish(command.id);
    work.recordResponse(parent.workIds!, "unknown");
    const review = work.accept(commands.collectEvents()[0]).record;
    work.claim([review.id]);
    expect(() => commands.reconcile(parent.workId!, review.message, "Reviewed", work)).toThrow(/delivery/i);
  });
});
