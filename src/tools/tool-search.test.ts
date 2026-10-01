import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createToolDiscoveryExtension, TOOL_SEARCH_NAME } from "./tool-search.js";

function catalog() {
  const tools = [
    { name: "read", description: "Read files", exposure: "direct", parameters: Type.Object({}) },
    { name: "gdrive_read", description: "Read documents", exposure: "deferred",
      parameters: Type.Object({ spreadsheet: Type.String({ description: "Financial Google sheets" }) }),
      namespace: { name: "google_workspace" } },
    { name: "unsafe", description: "Financial Google sheets", exposure: "hidden", parameters: Type.Object({}) },
  ] as ToolInfo[];
  let active = ["read", TOOL_SEARCH_NAME];
  let search: ToolDefinition | undefined;
  const onChanged = vi.fn();
  const events = new Map<string, (...args: unknown[]) => void>();
  const pi = {
    registerTool(definition: ToolDefinition) { search = definition; },
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools(names: string[]) { active = names; },
    on(name: string, callback: (...args: unknown[]) => void) { events.set(name, callback); },
  } as unknown as ExtensionAPI;
  createToolDiscoveryExtension(onChanged)(pi);
  return { search: search!, onChanged, events, active: () => active };
}

describe("native tool discovery", () => {
  it("registers just the native search tool and activates it by default", () => {
    const { search } = catalog();
    expect(search.name).toBe("tool_search");
    expect(search.defaultActive).toBe(true);
    expect(search.exposure).toBe("model-only");
  });

  it("searches schema metadata and activates additively without exposing quarantine", async () => {
    const { search, onChanged, active } = catalog();
    const result = await search.execute("call", { query: "financial sheets", limit: 3 },
      undefined, undefined, {} as ExtensionToolContext);
    expect(active()).toEqual(["read", "tool_search", "gdrive_read"]);
    expect(result.details).toEqual({ loaded: ["gdrive_read"] });
    expect(onChanged.mock.calls.at(-1)?.[0].map((tool: ToolInfo) => tool.name)).toEqual(["read", "gdrive_read"]);
  });

  it("refreshes the prompt catalog on session start and subsequent turns", () => {
    const { onChanged, events } = catalog();
    events.get("session_start")!({}, { sessionManager: { buildSessionProjection: () => ({ messages: [] }) } });
    events.get("before_agent_start")!();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});
