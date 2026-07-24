import { describe, expect, it, vi } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  configureDynamicToolLoading,
  createToolSearch,
  getInitialToolNames,
} from "./tool-search.js";

function tool(name: string, description: string): ToolInfo {
  return {
    name,
    description,
    parameters: {},
    promptGuidelines: [],
    sourceInfo: {
      path: `<test:${name}>`,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
  } as ToolInfo;
}

describe("getInitialToolNames", () => {
  it("keeps core tools active and defers extension tools", () => {
    const tools = [
      tool("read", "Read files"),
      tool("memory_archival_search", "Search memory"),
      tool("search_tools", "Load more tools"),
      tool("search_gdrive", "Search Google Drive"),
      tool("gdrive_read", "Read Google Drive files"),
    ];

    const active = getInitialToolNames(
      tools,
      new Set(["search_gdrive", "gdrive_read"]),
    );

    expect(active).toEqual([
      "read",
      "memory_archival_search",
      "search_tools",
    ]);
  });
});

describe("configureDynamicToolLoading", () => {
  it("starts with core tools and reports later activations", async () => {
    const tools = [
      tool("read", "Read files"),
      tool("search_tools", "Load more tools"),
      tool("search_gdrive", "Search Google Drive files"),
    ];
    let activeNames = tools.map((item) => item.name);
    const activeSnapshots: string[][] = [];
    const controller = createToolSearch();

    configureDynamicToolLoading(
      controller,
      {
        getAllTools: () => tools,
        getActiveToolNames: () => activeNames,
        setActiveToolsByName: (names) => {
          activeNames = names;
        },
      },
      new Set(["search_gdrive"]),
      (activeTools) => {
        activeSnapshots.push(activeTools.map((item) => item.name));
      },
    );

    expect(activeNames).toEqual(["read", "search_tools"]);
    expect(activeSnapshots).toEqual([["read", "search_tools"]]);

    await controller.tool.execute(
      "call-1",
      { query: "google drive" },
      undefined,
      undefined,
    );

    expect(activeNames).toEqual(["read", "search_tools", "search_gdrive"]);
    expect(activeSnapshots.at(-1)).toEqual([
      "read",
      "search_tools",
      "search_gdrive",
    ]);
  });

  it("never exposes quarantined extension tools", async () => {
    const tools = [
      tool("read", "Read files"),
      tool("search_tools", "Load more tools"),
      tool("unsafe_extension_tool", "Unsafe extension capability"),
    ];
    let activeNames = tools.map((item) => item.name);
    const controller = createToolSearch();

    configureDynamicToolLoading(
      controller,
      {
        getAllTools: () => tools,
        getActiveToolNames: () => activeNames,
        setActiveToolsByName: (names) => {
          activeNames = names;
        },
      },
      new Set(["unsafe_extension_tool"]),
      () => {},
      new Set(["unsafe_extension_tool"]),
    );

    const result = await controller.tool.execute(
      "call-2",
      { query: "unsafe extension" },
      undefined,
      undefined,
    );

    expect(activeNames).toEqual(["read", "search_tools"]);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "No inactive tools found for: unsafe extension",
    });
  });
});

describe("createToolSearch", () => {
  it("loads matching inactive tools without disabling active tools", async () => {
    let activeNames = ["read", "search_tools"];
    const setActiveToolNames = vi.fn((names: string[]) => {
      activeNames = names;
    });
    const controller = createToolSearch();
    controller.bind({
      getTools: () => [
        tool("read", "Read files"),
        tool("search_tools", "Load more tools"),
        tool("search_gdrive", "Search Google Drive files"),
        tool("gdrive_read", "Read a Google Drive file"),
        tool("search_gmail", "Search Gmail messages"),
      ],
      getActiveToolNames: () => activeNames,
      setActiveToolNames,
    });

    const result = await controller.tool.execute(
      "call-1",
      { query: "google drive", limit: 2 },
      undefined,
      undefined,
    );

    expect(setActiveToolNames).toHaveBeenCalledWith([
      "read",
      "search_tools",
      "gdrive_read",
      "search_gdrive",
    ]);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Loaded tools: gdrive_read, search_gdrive",
    });
    expect(result.addedToolNames).toEqual(["gdrive_read", "search_gdrive"]);
  });

  it("returns a bounded no-match result without changing tools", async () => {
    const setActiveToolNames = vi.fn();
    const controller = createToolSearch();
    controller.bind({
      getTools: () => [
        tool("read", "Read files"),
        tool("search_tools", "Load more tools"),
      ],
      getActiveToolNames: () => ["read", "search_tools"],
      setActiveToolNames,
    });

    const result = await controller.tool.execute(
      "call-2",
      { query: "weather radar" },
      undefined,
      undefined,
    );

    expect(setActiveToolNames).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "No inactive tools found for: weather radar",
    });
  });
});
