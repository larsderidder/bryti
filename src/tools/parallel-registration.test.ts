import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createCoreMemory } from "../memory/core-memory.js";
import { createMemoryStore } from "../memory/store.js";
import { createProjectionStore } from "../projection/store.js";
import { createTools } from "./index.js";
import { createTrustStore, getToolCapabilities, wrapToolWithTrustCheck } from "../trust/index.js";

describe("Parallel tool registration", () => {
  let directory: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-parallel-registration-"));
    previousDataDir = process.env.BRYTI_DATA_DIR;
    process.env.BRYTI_DATA_DIR = directory;
    fs.writeFileSync(path.join(directory, "config.yml"), JSON.stringify({
      telegram: { token: "test-token" }, models: { providers: [{ name: "openai", api: "openai-responses", models: [] }] },
      tools: { web_search: { enabled: true, parallel_enabled: true, searxng_url: "https://search.example.com" } },
    }));
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.BRYTI_DATA_DIR;
    } else {
      process.env.BRYTI_DATA_DIR = previousDataDir;
    }
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([true, false])("respects the main-agent web group: %s", (directWeb) => {
    const config = loadConfig();
    config.agent_def.tool_groups = [];
    if (directWeb) {
      config.agent_def.tool_groups.push("web");
    }
    const projections = createProjectionStore("owner", directory);
    try {
      const tools = createTools(config, createCoreMemory(directory), "owner", undefined, undefined, projections);
      expect(tools.some((tool) => tool.name === "parallel_search")).toBe(directWeb);
      expect(tools.some((tool) => tool.name === "parallel_fetch")).toBe(directWeb);
      expect(tools.some((tool) => tool.name === "web_search")).toBe(directWeb);
      if (directWeb) {
        expect(getToolCapabilities("parallel_search")).toMatchObject({ level: "elevated", capabilities: ["network"] });
        expect(getToolCapabilities("parallel_fetch")).toMatchObject({ level: "elevated", capabilities: ["network"] });
      }
    } finally {
      projections.close();
      createMemoryStore("owner", directory).close();
    }
  });

  it("does not contact Parallel when Bryti's guardrail blocks a main-agent call", async () => {
    const config = loadConfig();
    config.agent_def.tool_groups = ["web"];
    const projections = createProjectionStore("owner", directory);
    const trust = createTrustStore(directory);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
    try {
      const tool = createTools(config, createCoreMemory(directory), "owner", undefined, undefined, projections)
        .find((entry) => entry.name === "parallel_search")!;
      const guarded = wrapToolWithTrustCheck(tool, trust, "owner", {
        config, getLastUserMessage: () => "research public documentation",
        evaluateToolCall: async () => ({ verdict: "BLOCK", reason: "fixture block" }),
      });
      const result = await guarded.execute("blocked", { objective: "Find docs", search_queries: ["public docs"] });
      expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("fixture block") }]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      projections.close();
      createMemoryStore("owner", directory).close();
    }
  });
});
