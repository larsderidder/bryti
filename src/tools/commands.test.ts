import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandTools } from "./commands.js";
import { createWorkStore, type WorkStore } from "../work/store.js";
import { createCommandStore } from "../work/commands.js";
import type { IncomingMessage } from "../channels/types.js";
import { createProjectionStore } from "../projection/store.js";

describe("command tools", () => {
  let dir: string;
  let work: WorkStore;
  let target: IncomingMessage;
  const launch = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    launch.mockClear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-command-tools-"));
    work = createWorkStore(dir);
    target = work.accept({ userId: "u", channelId: "u", platform: "telegram", text: "build", raw: null }).record.message;
    work.claim(target.workIds!);
  });
  afterEach(() => {
    work.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists a command before launching and returns without waiting", async () => {
    const tools = createCommandTools(dir, () => target, 2, launch);
    const result = await tools[0].execute("call", { command: "sleep 10", cwd: dir, timeout_seconds: 20 });
    expect(result.details).not.toHaveProperty("error");
    expect(launch).toHaveBeenCalledOnce();
    const store = createCommandStore(dir);
    expect(store.forWork(target.workId!)).toHaveLength(1);
    store.close();
  });

  it("refuses late launch attempts after the parent was interrupted", async () => {
    work.finish(target.workIds!, "interrupted");
    const tools = createCommandTools(dir, () => target, 2, launch);
    const result = await tools[0].execute("call", { command: "sleep 10", cwd: dir, timeout_seconds: 20 });
    expect(result.details).toHaveProperty("error");
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not expose another user's command", async () => {
    const tools = createCommandTools(dir, () => target, 2, launch);
    await tools[0].execute("call", { command: "true", cwd: dir, timeout_seconds: 20 });
    const store = createCommandStore(dir);
    const record = store.forWork(target.workId!)[0];
    store.close();
    target = { ...target, userId: "other" };
    const result = await tools[1].execute("check", { command_id: record.id });
    expect(result.details).toHaveProperty("error");
  });

  it("refuses new commands from a cancelled reminder's completion", async () => {
    const projections = createProjectionStore("u", dir);
    const id = projections.add({ summary: "Develop", resolution: "exact", resolved_when: "2026-09-11 08:00" });
    target = work.accept({ ...target, workId: `projection:u:${id}:2026-09-11 08:00`, raw: { type: "projection_exact_check" } }).record.message;
    work.claim(target.workIds!);
    const tools = createCommandTools(dir, () => target, 2, launch);
    await tools[0].execute("first", { command: "true", cwd: dir, timeout_seconds: 20 });
    work.finish(target.workIds!, "completed");
    const commands = createCommandStore(dir);
    try {
      const record = commands.forWork(target.workId!)[0];
      commands.finish(record.id, "complete", 0);
      target = work.accept(commands.collectEvents()[0]).record.message;
      work.claim(target.workIds!);
      projections.resolve(id, "done");
      const result = await tools[0].execute("second", { command: "true", cwd: dir, timeout_seconds: 20 });
      expect(result.details).toHaveProperty("error");
      expect(launch).toHaveBeenCalledOnce();
    } finally {
      commands.close();
      projections.close();
    }
  });
  it("runs the real detached runner and recovers completion after the parent turn ends", async () => {
    const tools = createCommandTools(dir, () => target, 2);
    const result = await tools[0].execute("real", { command: "printf runner-finished", cwd: dir, timeout_seconds: 5 });
    expect(result.details).not.toHaveProperty("error");
    work.finish(target.workIds!, "interrupted");
    const commands = createCommandStore(dir);
    try {
      await vi.waitFor(() => expect(commands.forWork(target.workId!)[0].status).toBe("complete"), { timeout: 4000 });
      expect(commands.collectEvents()).toHaveLength(1);
      const record = commands.forWork(target.workId!)[0];
      expect(record.pid).not.toBe(process.pid);
      expect(fs.readFileSync(record.logPath, "utf8")).toBe("runner-finished");
    } finally {
      commands.close();
    }
  });

  it("keeps an OS-enforced deadline when the runner is killed", async () => {
    const tools = createCommandTools(dir, () => target, 2);
    await tools[0].execute("crash", { command: "printf started; sleep 3; printf unsafe > escaped", cwd: dir, timeout_seconds: 1 });
    const commands = createCommandStore(dir);
    try {
      await vi.waitFor(() => {
        const record = commands.forWork(target.workId!)[0];
        expect(record.status).toBe("running");
        expect(fs.readFileSync(record.logPath, "utf8")).toBe("started");
      }, { timeout: 3000, interval: 10 });
      const record = commands.forWork(target.workId!)[0];
      expect(record.pid).not.toBe(process.pid);
      process.kill(record.pid!, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 3300));
      expect(fs.existsSync(path.join(dir, "escaped"))).toBe(false);
      expect(commands.collectEvents()[0].text).toContain("interrupted");
    } finally {
      commands.close();
    }
  }, 8000);
});
