import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { AgentTool, AgentMessage } from "@earendil-works/pi-agent-core";
import type { IncomingMessage } from "../channels/types.js";
import type { Config } from "../config.js";
import { createWorkStore, type WorkStore } from "./store.js";
import { EffectStore, resolveEffectResult, withEffectStore, wrapEffectTool } from "./effects.js";
import { createTrustStore } from "../trust/store.js";
import { wrapToolWithTrustCheck } from "../trust/wrapper.js";
import { repairToolUseResultPairing } from "../compaction/transcript-repair.js";

describe("effect receipts", () => {
  let dir: string;
  let work: WorkStore;
  let owner: IncomingMessage;
  let tool: AgentTool;
  const args = { content: "Private user-provided content" };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-effects-"));
    work = createWorkStore(dir);
    owner = work.accept({ userId: "u", platform: "telegram", channelId: "chat", threadId: "default", text: "request", raw: null }).record.message;
    work.claim(owner.workIds!);
    tool = { name: "file_write", label: "write", description: "write a file",
      parameters: Type.Object({ content: Type.String() }),
      execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Saved" }], details: { saved: true } }) };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    work.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("commits intent before execution and restores the result without repeating the action", async () => {
    vi.mocked(tool.execute).mockImplementation(async () => {
      expect(withEffectStore(dir, (store) => store.list("u"))[0].state).toBe("running");
      return { content: [{ type: "text", text: "Saved" }], details: { saved: true } };
    });
    const wrapped = wrapEffectTool(tool, dir, () => owner);
    const result = await wrapped.execute("call", args);
    expect(await wrapped.execute("call", args)).toEqual(result);
    expect(tool.execute).toHaveBeenCalledOnce();
    const receipt = withEffectStore(dir, (store) => store.list("u"))[0];
    expect(receipt.state).toBe("completed");
    expect(JSON.stringify(receipt)).not.toContain(args.content);
  });

  it("refuses to repeat an action whose committed intent has no result", async () => {
    withEffectStore(dir, (store) => store.accept(owner, "call", tool.name, args, "implementation"));
    withEffectStore(dir, (store) => store.recover());
    const result = await wrapEffectTool(tool, dir, () => owner).execute("call", args);
    expect(JSON.stringify(result)).toContain("outcome unknown");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("keeps a thrown action unresolved rather than assuming it had no effects", async () => {
    vi.mocked(tool.execute).mockRejectedValue(new Error("connection lost"));
    const wrapped = wrapEffectTool(tool, dir, () => owner);
    await expect(wrapped.execute("call", args)).rejects.toThrow("connection lost");
    expect(withEffectStore(dir, (store) => store.list("u"))[0].state).toBe("unknown");
    expect(JSON.stringify(await wrapped.execute("call", args))).toContain("outcome unknown");
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("does not turn a failed outcome commit into permission to run again", async () => {
    const fail = vi.spyOn(EffectStore.prototype, "finish").mockImplementation(() => { throw new Error("disk full"); });
    const wrapped = wrapEffectTool(tool, dir, () => owner);
    await expect(wrapped.execute("call", args)).rejects.toThrow("disk full");
    fail.mockRestore();
    await wrapped.execute("call", args);
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("rejects changed arguments under the same work and call identity", async () => {
    const wrapped = wrapEffectTool(tool, dir, () => owner);
    await wrapped.execute("call", args);
    await expect(wrapped.execute("call", { content: "different" })).rejects.toThrow("different arguments");
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("does not infer a replay policy for unknown extension or MCP tools", () => {
    const extension = { ...tool, name: "extension_write" };
    expect(wrapEffectTool(extension, dir, () => owner)).toBe(extension);
  });

  it("checks current permissions before execution even when a receipt exists", async () => {
    const inner = wrapEffectTool(tool, dir, () => owner);
    const evaluate = vi.fn().mockResolvedValue({ verdict: "ALLOW", reason: "authorized" });
    const wrapped = wrapToolWithTrustCheck(inner, createTrustStore(dir), "u", {
      config: {} as Config, getLastUserMessage: () => "write", evaluateToolCall: evaluate,
    }, { level: "elevated", capabilities: ["filesystem"] });
    await wrapped.execute("call", args);
    evaluate.mockResolvedValue({ verdict: "BLOCK", reason: "authorization changed" });
    expect(JSON.stringify(await wrapped.execute("call", args))).toContain("Blocked");
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("requires an active work receipt belonging to the same destination", async () => {
    const wrongOwner = { ...owner, channelId: "different-chat" };
    await expect(wrapEffectTool(tool, dir, () => wrongOwner).execute("call", args)).rejects.toThrow("active owning work");
    work.finish(owner.workIds!, "completed");
    await expect(wrapEffectTool(tool, dir, () => owner).execute("call", args)).rejects.toThrow("active owning work");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("binds recovered results to the actual conversation and assistant turn", async () => {
    const context = { sessionId: "session-a", assistantTimestamp: 123 };
    await wrapEffectTool(tool, dir, () => owner, undefined, () => context).execute("call", args);
    const call = { id: "call", name: tool.name, arguments: args, assistantTimestamp: 123 };
    expect(resolveEffectResult(dir, "u", "default", call, "session-a")?.isError).toBe(false);
    expect(resolveEffectResult(dir, "u", "default", call, "session-b")).toBeUndefined();
    expect(resolveEffectResult(dir, "u", "default", { ...call, assistantTimestamp: 124 }, "session-a")).toBeUndefined();
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("repairs a missing SDK tool result from its matching receipt without executing anything", async () => {
    await wrapEffectTool(tool, dir, () => owner).execute("call", args);
    const assistant = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call", name: "file_write", arguments: args }] } as AgentMessage;
    const report = repairToolUseResultPairing([assistant], (call) => resolveEffectResult(dir, "u", "default", call));
    expect(report.messages[1]).toMatchObject({ role: "toolResult", toolCallId: "call", isError: false,
      content: [{ type: "text", text: "Saved" }] });
    expect(resolveEffectResult(dir, "different-user", "default", { id: "call", name: tool.name, arguments: args })).toBeUndefined();
    expect(resolveEffectResult(dir, "u", "other-thread", { id: "call", name: tool.name, arguments: args })).toBeUndefined();
    expect(tool.execute).toHaveBeenCalledOnce();
  });
});
