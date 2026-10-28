import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "../channels/types.js";
import { scheduledWorkId } from "../projection/occurrence.js";
import { createProjectionStore, type ProjectionStore } from "../projection/store.js";
import { getActiveTask } from "./active-task.js";

let directory: string;
let store: ProjectionStore;
afterEach(() => {
  store?.close();
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

  it("keeps human requests and other internal events separate from scheduled scope", () => {
    const { message } = fixture();
    expect(getActiveTask({ ...message, raw: null }, store)).toBeUndefined();
    const completion = { ...message, raw: { type: "command_completion" }, text: "Review this command" };
    expect(getActiveTask(completion, store)).toEqual({ source: "command_completion", request: completion.text });
  });
});
