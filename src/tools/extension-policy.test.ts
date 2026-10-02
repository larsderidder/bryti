import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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


  it.each(["reviewed", "changed", "other-source", "unverified-hint"])("only skips first-use approval for an unchanged operator-reviewed implementation: %s", async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-read-policy-"));
    directories.push(directory);
    const file = path.join(directory, "read-integration.ts");
    fs.writeFileSync(file, "reviewed read implementation");
    const tool = definition();
    tool.name = "read_integration";
    const approve = vi.fn().mockResolvedValue("deny");
    const evaluate = vi.fn(async () => ({ verdict: "ALLOW" as const, reason: "routine integration read" }));
    const policy = createExtensionToolPolicy({
      userId: "user", trustStore: createTrustStore(directory),
      context: { config: { trust: { read_only_extensions: [{ path: file,
        sha256: crypto.createHash("sha256").update("reviewed read implementation").digest("hex"),
        tools: [tool.name] }] } } as never, getLastUserMessage: () => "read integration",
      evaluateToolCall: evaluate, onApprovalNeeded: approve },
    });
    let source = file;
    if (mode === "other-source") {
      source = path.join(directory, "other.ts");
      fs.writeFileSync(source, "reviewed read implementation");
    } else if (mode === "unverified-hint") {
      source = "<inline:untrusted-server>";
    }
    const protectedTool = policy.protect(tool, source);
    if (mode === "changed") {
      fs.writeFileSync(file, "changed implementation");
    }
    const result = await protectedTool.execute("call", { value: "x" }, undefined, undefined,
      { cwd: "sandbox" } as ExtensionToolContext);
    expect(evaluate).toHaveBeenCalledOnce();
    if (mode === "reviewed") {
      expect(approve).not.toHaveBeenCalled();
      expect(result.structuredContent).toEqual({ saved: true });
    } else {
      expect(approve).toHaveBeenCalledOnce();
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("denied") });
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
