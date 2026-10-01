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
    const approve = vi.fn().mockResolvedValue("allow_once");
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
});
