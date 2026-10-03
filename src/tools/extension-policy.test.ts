import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createTrustStore } from "../trust/store.js";
import { createExtensionToolPolicy } from "./extension-policy.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function definition(): ToolDefinition {
  return {
    name: "mcp__test__write", label: "Write", description: "Write a test record",
    parameters: Type.Object({ value: Type.String() }),
    outputSchema: Type.Object({ saved: Type.Boolean() }),
    annotations: { readOnlyHint: true }, namespace: { name: "mcp__test" },
    async execute(_id, _args, _signal, _update, context) {
      return { content: [{ type: "text", text: context.cwd }], details: {}, structuredContent: { saved: true } };
    },
  };
}

describe("extension tool policy", () => {
  it("fails closed without an application approval context, despite read-only hints", async () => {
    const protectedTool = createExtensionToolPolicy({ userId: "user" }).protect(definition());
    expect(protectedTool.exposure).toBe("hidden");
    await expect(protectedTool.execute("call", { value: "x" }, undefined, undefined,
      { cwd: "sandbox" } as ExtensionToolContext)).rejects.toThrow("approval context");
  });

  it("quarantines unsupported schemas before discovery", () => {
    const tool = definition();
    tool.parameters = Type.Object({ value: Type.Union([Type.String(), Type.Number()]) });
    const policy = createExtensionToolPolicy({ userId: "user" });
    expect(policy.protect(tool).exposure).toBe("hidden");
    expect(policy.quarantinedNames.has(tool.name)).toBe(true);
  });

  it("uses Bryti approvals and preserves context, annotations, schemas, and structured results", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-mcp-policy-"));
    directories.push(directory);
    const store = createTrustStore(directory);
    const approve = vi.fn().mockResolvedValue("allow");
    const policy = createExtensionToolPolicy({
      userId: "user", trustStore: store,
      context: { config: {} as never, getLastUserMessage: () => "write a record",
        evaluateToolCall: async () => ({ verdict: "ASK", reason: "confirm write" }),
        onApprovalNeeded: approve },
    });
    const tool = definition();
    const protectedTool = policy.protect(tool);
    expect(protectedTool.exposure).toBe("deferred");
    expect(protectedTool.annotations).toEqual(tool.annotations);
    expect(protectedTool.outputSchema).toBe(tool.outputSchema);
    const result = await protectedTool.execute("call", { value: "x" }, undefined, undefined,
      { cwd: "sandbox" } as ExtensionToolContext);
    expect(approve).toHaveBeenCalledOnce();
    expect(result.structuredContent).toEqual({ saved: true });
    expect(result.content[0]).toMatchObject({ text: "sandbox" });
  });


  it.each(["gmail_get_message", "google_calendar_today", "loki_query_sbl-prod", "mcp__test__read"])("executes allowed integration reads without pins or first-use approval: %s", async (name) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-read-policy-"));
    directories.push(directory);
    const tool = definition();
    tool.name = name;
    tool.description = "Read a configured integration";
    const approve = vi.fn().mockResolvedValue("deny");
    const evaluate = vi.fn(async () => ({ verdict: "ALLOW" as const, reason: "routine integration read" }));
    const policy = createExtensionToolPolicy({
      userId: "user", trustStore: createTrustStore(directory),
      context: { config: {} as never, getLastUserMessage: () => "continue",
        getOperationalGuidelines: () => "Routine reads support the agent's standing tasks.",
        evaluateToolCall: evaluate, onApprovalNeeded: approve },
    });
    const protectedTool = policy.protect(tool);
    const context = { cwd: "sandbox" } as ExtensionToolContext;
    await protectedTool.execute("first", { value: "first" }, undefined, undefined, context);
    const result = await protectedTool.execute("second", { value: "second" }, undefined, undefined, context);

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(approve).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({ saved: true });
  });

  it.each(["ASK", "BLOCK"] as const)("does not let read-only hints override guardrail %s", async (verdict) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-verdict-policy-"));
    directories.push(directory);
    const approve = vi.fn().mockResolvedValue("deny");
    const tool = definition();
    const execute = vi.fn(tool.execute);
    tool.execute = execute;
    const policy = createExtensionToolPolicy({
      userId: "user", trustStore: createTrustStore(directory),
      context: { config: {} as never, getLastUserMessage: () => "continue",
        evaluateToolCall: async () => ({ verdict, reason: "outside routine scope" }), onApprovalNeeded: approve },
    });
    await policy.protect(tool).execute("call", { value: "x" }, undefined, undefined,
      { cwd: "sandbox" } as ExtensionToolContext);
    expect(execute).not.toHaveBeenCalled();
    if (verdict === "ASK") {
      expect(approve).toHaveBeenCalledOnce();
    } else {
      expect(approve).not.toHaveBeenCalled();
    }
  });


  it("does not reuse a grant made while the loaded implementation differed from its source file", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-loaded-policy-"));
    directories.push(directory);
    const file = path.join(directory, "integration.ts");
    fs.writeFileSync(file, "loaded implementation");
    const approve = vi.fn().mockResolvedValueOnce("allow_always").mockResolvedValue("deny");
    const evaluate = vi.fn().mockResolvedValue({ verdict: "ASK", reason: "review this implementation" });
    const policy = createExtensionToolPolicy({
      userId: "user", trustStore: createTrustStore(directory),
      context: { config: {} as never, getLastUserMessage: () => "write a record",
        evaluateToolCall: evaluate, onApprovalNeeded: approve },
    });
    const loaded = policy.protect(definition(), file);
    fs.writeFileSync(file, "replacement implementation");
    const context = { cwd: "sandbox" } as ExtensionToolContext;
    expect((await loaded.execute("first", { value: "x" }, undefined, undefined, context)).structuredContent)
      .toEqual({ saved: true });
    const reloaded = policy.protect(definition(), file);
    const result = await reloaded.execute("second", { value: "x" }, undefined, undefined, context);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("denied") });
  });
});
