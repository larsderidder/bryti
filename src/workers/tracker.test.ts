import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { attachWorkerRunTracker } from "./tracker.js";

it("includes nested and auxiliary usage, and records steering without retaining guidance", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-worker-tracker-"));
  let listener!: (event: AgentSessionEvent) => void;
  const session = { sessionId: "fixture", subscribe: (fn: typeof listener) => { listener = fn; return () => {}; },
    getContextUsage: () => null, steer: vi.fn().mockResolvedValue("handled") } as unknown as AgentSession;
  const tracker = attachWorkerRunTracker({ session, workerDir: directory, maxTurns: 2, writeStatus: vi.fn() });
  try {
    const usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, totalTokens: 135,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } };
    listener({ type: "message_end", message: { role: "toolResult", toolName: "read", toolCallId: "fixture",
      timestamp: 1, isError: false, content: [{ type: "text", text: "private-fixture" }], usage } });
    listener({ type: "entry_appended", entry: { type: "usage", id: "usage", parentId: null,
      timestamp: new Date().toISOString(), kind: "cache_warm", provider: "fixture", model: "fixture", usage } });
    listener({ type: "tool_execution_start", toolName: "read", toolCallId: "parent/1", parentToolCallId: "parent", args: { secret: "private-fixture" } });
    listener({ type: "tool_execution_end", toolName: "read", toolCallId: "parent/1", parentToolCallId: "parent", result: {}, isError: false });
    listener({ type: "turn_end", message: { role: "user", content: "private-fixture", timestamp: 1 }, toolResults: [] });
    await Promise.resolve();
    expect(tracker.progress).toMatchObject({ input_tokens: 20, output_tokens: 10, cache_read_tokens: 200, cost_usd: 2 });
    const output = fs.readFileSync(tracker.paths.transcript_path, "utf8");
    expect(output).toContain('"parent_tool_call_id":"parent"');
    expect(output).toContain('"disposition":"handled"');
    expect(output).not.toContain("private-fixture");
  } finally {
    tracker.unsubscribe();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
