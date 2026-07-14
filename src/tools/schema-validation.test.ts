import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { quarantineInvalidExtensionTools, validateToolSchema } from "./schema-validation.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

describe("validateToolSchema", () => {
  it("accepts ordinary object schemas", () => {
    const issues = validateToolSchema("ok_tool", Type.Object({
      query: Type.String(),
      count: Type.Optional(Type.Integer()),
    }));

    expect(issues).toEqual([]);
  });

  it("rejects unsupported schema keywords", () => {
    const issues = validateToolSchema("bad_tool", {
      type: "object",
      properties: {
        value: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
    });

    expect(issues.map((issue) => issue.message)).toContain(
      'parameters.properties.value.oneOf: unsupported schema keyword "oneOf"',
    );
  });

  it("accepts simple Type.Union literal enums", () => {
    const issues = validateToolSchema("enum_tool", Type.Object({
      mode: Type.Union([Type.Literal("a"), Type.Literal("b")]),
    }));

    expect(issues).toEqual([]);
  });
});

describe("quarantineInvalidExtensionTools", () => {
  it("removes invalid extension tools from the active tool set", () => {
    const setActiveToolsByName = vi.fn();
    const session = {
      getAllTools: () => [
        { name: "good_ext", description: "", parameters: Type.Object({ q: Type.String() }), sourceInfo: {} },
        { name: "bad_ext", description: "", parameters: { type: "object", properties: { q: { oneOf: [] } } }, sourceInfo: {} },
        { name: "core_tool", description: "", parameters: { type: "object", properties: { q: { oneOf: [] } } }, sourceInfo: {} },
      ],
      getActiveToolNames: () => ["good_ext", "bad_ext", "core_tool"],
      setActiveToolsByName,
    } as unknown as AgentSession;

    const issues = quarantineInvalidExtensionTools(session, new Set(["good_ext", "bad_ext"]));

    expect(issues).toHaveLength(1);
    expect(issues[0].toolName).toBe("bad_ext");
    expect(setActiveToolsByName).toHaveBeenCalledWith(["good_ext", "core_tool"]);
  });
});
