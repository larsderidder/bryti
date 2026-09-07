import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProjectionStore } from "./store.js";
import { createProjectionTools } from "./tools.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bryti-proj-tools-test-"));
}

describe("ProjectionTools dependencies", () => {
  let tempDir: string;
  let store: ReturnType<typeof createProjectionStore>;
  let tools: ReturnType<typeof createProjectionTools>;

  beforeEach(() => {
    tempDir = makeTempDir();
    store = createProjectionStore("user1", tempDir);
    tools = createProjectionTools(store, "UTC");
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("project supports depends_on", async () => {
    const subjectId = store.add({ summary: "Meeting" });
    const projectTool = tools.find((t) => t.name === "projection_create");
    expect(projectTool).toBeDefined();

    const result = await projectTool!.execute(
      "call1",
      {
        summary: "Send recap",
        depends_on: [{ projection_id: subjectId, condition: "done" }],
      },
      undefined,
      undefined,
      undefined as any,
    );

    expect((result.details as any).success).toBe(true);
    const observerId = (result.details as any).id as string;
    const deps = store.getDependencies(observerId);
    expect(deps).toHaveLength(1);
    expect(deps[0].subject_id).toBe(subjectId);
    expect(deps[0].condition).toBe("done");
    expect(deps[0].condition_type).toBe("status_change");
  });


  it("stores the latest target from the target getter", async () => {
    let currentTarget = {
      userId: "user1",
      channelId: "first-channel",
      platform: "telegram",
      threadId: "first-thread",
    };
    tools = createProjectionTools(store, "UTC", () => currentTarget);
    currentTarget = {
      userId: "user1",
      channelId: "second-channel",
      platform: "telegram",
      threadId: "second-thread",
    };
    const projectTool = tools.find((t) => t.name === "projection_create");
    expect(projectTool).toBeDefined();

    const result = await projectTool!.execute(
      "call-target",
      { summary: "Targeted reminder", when: "2026-02-19T10:00" },
      undefined,
      undefined,
      undefined as any,
    );

    const id = (result.details as any).id as string;
    expect(store.getById(id)).toMatchObject({
      target_user_id: "user1",
      target_channel_id: "second-channel",
      target_platform: "telegram",
      target_thread_id: "second-thread",
    });
  });

  it("projection_link links existing projections", async () => {
    const subjectId = store.add({ summary: "Call" });
    const observerId = store.add({ summary: "Follow-up email" });
    const linkTool = tools.find((t) => t.name === "projection_link");
    expect(linkTool).toBeDefined();

    const result = await linkTool!.execute(
      "call2",
      {
        observer_id: observerId,
        subject_id: subjectId,
        condition: "done",
      },
      undefined,
      undefined,
      undefined as any,
    );

    expect((result.details as any).success).toBe(true);
    const deps = store.getDependencies(observerId);
    expect(deps).toHaveLength(1);
    expect(deps[0].subject_id).toBe(subjectId);
  });
});
