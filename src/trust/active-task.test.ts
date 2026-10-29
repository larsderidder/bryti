import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "../channels/types.js";
import { scheduledWorkId } from "../projection/occurrence.js";
import { createProjectionStore, type ProjectionStore } from "../projection/store.js";
import { getActiveTask } from "./active-task.js";
import { createCommandStore, type CommandStore } from "../work/commands.js";
import { createWorkStore, type WorkStore } from "../work/store.js";

let directory: string;
let store: ProjectionStore;
let work: WorkStore | undefined;
let commands: CommandStore | undefined;
afterEach(() => {
  store?.close();
  work?.close();
  commands?.close();
  work = undefined;
  commands = undefined;
  if (directory) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("guardrail active scheduled task", () => {
  function fixture() {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-active-task-"));
    store = createProjectionStore("owner", directory);
    const context = "Existing-job repair and normal project releases are authorized. ".repeat(150) +
      "Preserve owner-disabled jobs. No spending or unrelated infrastructure changes.";
    const id = store.add({ summary: "Repair the existing watcher", context,
      resolution: "exact", resolved_when: "2026-10-27 08:30",
      target: { userId: "owner", channelId: "group", platform: "telegram", threadId: "tcg", channelThreadId: "32" } });
    const projection = store.getById(id)!;
    const message: IncomingMessage = { userId: "owner", channelId: "group", platform: "telegram",
      threadId: "tcg", channelThreadId: "32", workId: scheduledWorkId("owner", projection),
      text: "The full instructions are too large to inline. Call projection_read.", raw: { type: "projection_exact_check" } };
    return { context, projection, message };
  }

  it("gives the checker the full stored scope and limits behind a bounded reminder", () => {
    const { context, message } = fixture();
    const task = getActiveTask(message, store)!;
    expect(task.source).toBe("projection_exact_check");
    expect(task.request).toContain(message.text);
    expect(task.request).toContain(context);
    expect(task.request).toContain("Repair the existing watcher");
  });

  it.each([
    { userId: "other" },
    { channelId: "other" },
    { platform: "whatsapp" as const },
    { threadId: "other" },
    { channelThreadId: "other" },
    { workId: "projection:owner:missing:2026-10-27 08:30" },
  ])("does not expose a projection to a mismatched occurrence or destination %j", (change) => {
    const { context, message } = fixture();
    expect(getActiveTask({ ...message, ...change }, store)?.request).not.toContain(context);
  });

  it.each(["cancelled", "rescheduled"])("does not attach instructions from a %s occurrence", (change) => {
    const { context, projection, message } = fixture();
    if (change === "rescheduled") {
      store.update(projection.id, { resolved_when: "2026-10-28 08:30" });
    } else {
      store.resolve(projection.id, "cancelled");
    }
    expect(getActiveTask(message, store)?.request).not.toContain(context);
  });

  function completionFixture() {
    const result = fixture();
    work = createWorkStore(directory);
    commands = createCommandStore(directory);
    const parent = work.accept(result.message).record.message;
    work.claim([parent.workId!]);
    store.markDeliveryWork(result.projection.id, parent.workId!);
    const command = commands.accept(parent, "diagnostic-worker", {
      command: "printf diagnostics", cwd: directory, timeoutSeconds: 60,
    }, 1);
    commands.claim(command.id, process.pid, "test");
    commands.finish(command.id, "complete", 0);
    work.finish([parent.workId!], "completed");
    const completion = work.accept(commands.collectEvents()[0]).record.message;
    work.claim([completion.workId!]);
    return { ...result, completion, command, receipts: { work, commands } };
  }

  it("retains the owning task's full scope when a coding command returns for review", () => {
    const { context, completion, receipts, command, message } = completionFixture();
    const task = getActiveTask(completion, store, receipts)!;
    expect(task.source).toBe("command_completion");
    expect(task.request).toContain(completion.text);
    const evidence = JSON.parse(task.request.split("Stored scheduled-task evidence (not an independent permission grant):\n")[1]);
    expect(evidence.context).toBe(context);
    expect(evidence.owningRequest).toBe(message.text);
    expect(evidence.command).toEqual({ id: command.id, status: "complete", exitCode: 0 });
    expect(task.request).toContain("Do not rerun the command or repeat its actions");
  });

  it("preserves multiline scope as JSON evidence without altering completion receipts", () => {
    const { context, projection, completion, receipts } = completionFixture();
    const multiline = `${context}\nNo extra spending.\nPreserve explicit denials.`;
    store.update(projection.id, { context: multiline });
    const before = receipts.work.get(completion.workId!);
    const task = getActiveTask(completion, store, receipts)!;
    const evidence = JSON.parse(task.request.split("Stored scheduled-task evidence (not an independent permission grant):\n")[1]);
    expect(evidence.context).toBe(multiline);
    expect(receipts.work.get(completion.workId!)).toEqual(before);
  });

  it.each(["cancelled", "rescheduled", "unbound", "settled review", "wrong topic", "wrong owner", "running command", "missing command", "missing parent", "wrong command owner", "ambiguous parents", "interrupted parent", "forged review", "recovery"])(
    "does not attach task scope to a %s completion",
    (change) => {
      const { context, projection, completion, receipts, message } = completionFixture();
      let target = completion;
      if (change === "cancelled") {
        store.resolve(projection.id, "cancelled");
      } else if (change === "rescheduled") {
        store.update(projection.id, { resolved_when: "2026-10-28 08:30" });
      } else if (change === "unbound") {
        store.clearDeliveryWork(projection.id, scheduledWorkId("owner", projection));
      } else if (change === "settled review") {
        receipts.work.finish([completion.workId!], "completed");
      } else if (change === "wrong topic") {
        target = { ...completion, threadId: "other" };
      } else if (change === "wrong owner") {
        target = { ...completion, userId: "other" };
      } else if (change === "running command") {
        const originalGet = receipts.commands.get;
        receipts.commands = { ...receipts.commands, get: (id) => ({ ...originalGet(id)!, status: "running" }) };
      } else if (change === "missing command") {
        receipts.commands = { ...receipts.commands, get: () => null };
      } else if (change === "wrong command owner" || change === "ambiguous parents") {
        const originalGet = receipts.commands.get;
        receipts.commands = { ...receipts.commands, get: (id) => {
          const record = originalGet(id)!;
          if (change === "wrong command owner") {
            return { ...record, owner: { ...record.owner, userId: "other" } };
          }
          return { ...record, parentWorkIds: [...record.parentWorkIds, "other-work"] };
        } };
      } else if (["missing parent", "interrupted parent", "forged review"].includes(change)) {
        const originalGet = receipts.work.get;
        receipts.work = { ...receipts.work, get: (id) => {
          const record = originalGet(id)!;
          if (id === message.workId && change === "missing parent") {
            return null;
          }
          if (id === message.workId && change === "interrupted parent") {
            return { ...record, execution: "interrupted" };
          }
          if (id === completion.workId && change === "forged review") {
            return { ...record, message: { ...record.message, raw: { type: "work_recovery" } } };
          }
          return record;
        } };
      } else if (change === "recovery") {
        target = { ...completion, raw: { type: "work_recovery" } };
      }
      expect(getActiveTask(target, store, receipts)?.request).not.toContain(context);
    },
  );

  it("keeps human requests and other internal events separate from scheduled scope", () => {
    const { message } = fixture();
    expect(getActiveTask({ ...message, raw: null }, store)).toBeUndefined();
    const completion = { ...message, raw: { type: "command_completion" }, text: "Review this command" };
    expect(getActiveTask(completion, store)).toEqual({ source: "command_completion", request: completion.text });
  });
});
