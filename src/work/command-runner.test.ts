import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommandStore, type CommandStore } from "./commands.js";
import { runManagedCommand } from "./command-runner.js";

describe("managed command runner", () => {
  let dir: string;
  let commands: CommandStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-command-runner-"));
    commands = createCommandStore(dir);
  });
  afterEach(() => {
    commands.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function command(script: string, timeoutSeconds = 5) {
    return commands.accept({ userId: "u", channelId: "u", platform: "telegram", workId: "parent", text: "", raw: null },
      "tool-call", { command: script, cwd: dir, timeoutSeconds }, 1);
  }

  it("records real output and exit status, and cannot execute twice", async () => {
    const record = command("printf 'finished\\n'; printf x >> once");
    await runManagedCommand(dir, record.id);
    await runManagedCommand(dir, record.id);
    expect(commands.get(record.id)).toMatchObject({ status: "complete", exitCode: 0 });
    expect(fs.readFileSync(record.logPath, "utf8")).toBe("finished\n");
    expect(fs.readFileSync(path.join(dir, "once"), "utf8")).toBe("x");
  });

  it("does not mistake a nonzero exit for completion", async () => {
    const record = command("printf 'failed' >&2; exit 7");
    await runManagedCommand(dir, record.id);
    expect(commands.get(record.id)).toMatchObject({ status: "failed", exitCode: 7 });
  });

  it("terminates a silent command at its deadline", async () => {
    const record = command("sleep 20; printf should-not-run > late", 1);
    await runManagedCommand(dir, record.id);
    expect(commands.get(record.id)?.status).toBe("timeout");
    expect(fs.existsSync(path.join(dir, "late"))).toBe(false);
  });

  it("caps stored output without leaving a writer blocked", async () => {
    const record = command("yes output | head -c 5000");
    await runManagedCommand(dir, record.id, 1000);
    expect(commands.get(record.id)?.status).toBe("complete");
    expect(fs.statSync(record.logPath).size).toBeLessThanOrEqual(1100);
    expect(fs.readFileSync(record.logPath, "utf8")).toContain("truncated");
  });

  it("cleans up children left behind by a finished shell", async () => {
    const record = command("sleep 20 & printf done");
    await runManagedCommand(dir, record.id);
    expect(commands.get(record.id)?.status).toBe("complete");
  });
});
