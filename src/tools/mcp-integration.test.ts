import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createTrustStore } from "../trust/store.js";
import type { Config } from "../config.js";
import { createBrytiMcpExtension } from "./mcp.js";
import { createExtensionToolPolicy } from "./extension-policy.js";
import { createToolDiscoveryExtension } from "./tool-search.js";
import { createTranscriptRepairExtension } from "../compaction/session-repair.js";
import { Type } from "typebox";
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";

/** Exercise real SDK and native MCP transports against a local child process, with no model calls. */
describe("native MCP session contracts", () => {
  let directory: string;
  const sessions: AgentSession[] = [];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-mcp-session-"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function setup(approval = vi.fn().mockResolvedValue("allow_once"),
    manager = SessionManager.inMemory(directory), additional: ExtensionFactory[] = []) {
    const agentDirectory = path.join(directory, "agent");
    const userDirectory = path.join(directory, "users", "owner");
    fs.mkdirSync(userDirectory, { recursive: true });
    fs.writeFileSync(path.join(userDirectory, "mcp.json"), JSON.stringify({ mcpServers: {
      contract: { command: process.execPath,
        args: [fileURLToPath(new URL("./__fixtures__/mcp-server.mjs", import.meta.url))] },
    } }));
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDirectory, "auth.json"), modelsStorePath: path.join(agentDirectory, "models-store.json"),
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.getModel().provider, "offline-test");
    const settings = SettingsManager.inMemory({
      packages: [], defaultTools: ["tool_search"], retry: { enabled: false }, compaction: { enabled: false },
    });
    const store = createTrustStore(directory);
    const policy = createExtensionToolPolicy({ userId: "owner", trustStore: store,
      context: { config: {} as Config, getLastUserMessage: () => "write a record",
        evaluateToolCall: async () => ({ verdict: "ASK", reason: "Confirm exact arguments" }),
        onApprovalNeeded: approval },
    });
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: agentDirectory, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [policy.wrapFactory(createBrytiMcpExtension(directory, "owner")),
        createToolDiscoveryExtension(() => {}), createTranscriptRepairExtension(), ...additional],
      systemPrompt: "Offline MCP test",
    });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: directory, agentDir: agentDirectory,
      modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off",
      customTools: [], resourceLoader: loader, sessionManager: manager, settingsManager: settings,
    });
    sessions.push(session);
    await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
    return { session, faux, approval, manager, store };
  }

  it("discovers deferred MCP tools and executes only after Bryti approval, then closes the child", async () => {
    const { session, faux, approval } = await setup();
    expect(session.getActiveToolNames()).toEqual(["tool_search"]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "fixture record" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("mcp__contract__write", { value: "saved" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done"),
    ]);
    await session.prompt("Write a record");
    expect(approval).toHaveBeenCalledOnce();
    expect(session.getActiveToolNames()).toContain("mcp__contract__write");
    expect(session.getAllTools().some((tool) => tool.name === "codemode")).toBe(false);
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "mcp__contract__write");
    expect(result).toMatchObject({ isError: false });
    expect(result?.content[0]).toMatchObject({ type: "text" });
    const output = JSON.parse((result?.content[0] as { text: string }).text) as { pid: number; writes: number };
    expect(output.writes).toBe(1);
    expect(session.getAllTools().find((tool) => tool.name === "mcp__contract__write"))
      .toMatchObject({ annotations: { readOnlyHint: true }, namespace: { name: "mcp__contract" } });
    const pid = output.pid;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it("cancelled approvals cannot execute or save a grant", async () => {
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<"allow_always">();
    const approval = vi.fn(() => { entered.resolve(); return answer.promise; });
    const { session, faux, store } = await setup(approval);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "fixture" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("mcp__contract__write", { value: "not allowed" }), { stopReason: "toolUse" }),
    ]);
    const prompting = session.prompt("Write a record");
    await entered.promise;
    await session.abort();
    await prompting;
    answer.resolve("allow_always");
    await Promise.resolve();
    expect(store.listApproved()).toEqual([]);
    expect(session.messages.some((message) => message.role === "toolResult" &&
      message.content.some((block) => block.type === "text" && block.text.includes('"writes"')))).toBe(false);
  });

  it("native search activation survives reload and persisted session resume", async () => {
    const manager = SessionManager.create(directory, path.join(directory, "sessions"));
    const first = await setup(undefined, manager);
    first.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "fixture" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Tool loaded"),
    ]);
    await first.session.prompt("Find the record tool");
    await first.session.reload();
    // The tool must be connected again before native exposure can reconcile its saved loadout.
    first.faux.setResponses([fauxAssistantMessage("Reloaded")]);
    await first.session.prompt("Continue");
    expect(first.session.getActiveToolNames()).toContain("mcp__contract__write");
    const reloaded = await setup(undefined, SessionManager.open(manager.getSessionFile()!, directory));
    reloaded.faux.setResponses([fauxAssistantMessage("Resumed")]);
    await reloaded.session.prompt("Continue again");
    expect(reloaded.session.getActiveToolNames()).toContain("mcp__contract__write");
  });

  it("nested native calls retain structured results and cannot bypass denial", async () => {
    let outcome: AgentToolCallOutcome | undefined;
    const outer: ExtensionFactory = (pi) => pi.registerTool({
      name: "nested_write", label: "Nested write", description: "Offline nested-call test",
      parameters: Type.Object({}), exposure: "model-only",
      async execute(_id, _args, _signal, _update, context) {
        outcome = await context.executeTool("mcp__contract__write", { value: "nested" });
        return outcome.result;
      },
    });
    const approval = vi.fn().mockResolvedValue("deny");
    const { session, faux } = await setup(approval, undefined, [outer]);
    session.setActiveToolsByName(["nested_write"]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("nested_write", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Denied"),
    ]);
    await session.prompt("Write through another tool");
    expect(approval).toHaveBeenCalledOnce();
    expect(outcome?.result.content[0]).toMatchObject({ text: expect.stringContaining("denied permission") });
    expect(outcome?.result.structuredContent).toBeUndefined();
    approval.mockResolvedValue("allow_once");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("nested_write", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Allowed"),
    ]);
    await session.prompt("Allow the nested call now");
    expect(outcome?.result.structuredContent).toMatchObject({ structuredContent: { writes: 1 } });
    expect(approval).toHaveBeenCalledTimes(2);
  });

  it("repairs malformed canonical history for the provider without changing original entries", async () => {
    const manager = SessionManager.inMemory(directory);
    const assistant = fauxAssistantMessage(fauxToolCall("mcp__contract__write", { value: "unknown" }), { stopReason: "toolUse" });
    manager.appendMessage({ role: "user", content: "Earlier request", timestamp: 1 });
    manager.appendMessage(assistant);
    manager.appendMessage({ role: "toolResult", toolCallId: "orphan", toolName: "unknown",
      content: [{ type: "text", text: "orphan result" }], isError: false, timestamp: 2 });
    manager.appendCustomMessageEntry("delivery", "Confirmed delivery", false);
    const original = manager.getEntries();
    const { session, faux } = await setup(undefined, manager);
    faux.setResponses([(context) => {
      const repaired = context.messages.find((message) => message.role === "toolResult");
      expect(repaired).toMatchObject({ isError: true, toolCallId: assistant.content.find((block) => block.type === "toolCall")?.id });
      expect(JSON.stringify(context.messages)).toContain("Do not retry side effects");
      expect(JSON.stringify(context.messages)).toContain("Confirmed delivery");
      expect(JSON.stringify(context.messages)).not.toContain("orphan result");
      return fauxAssistantMessage("History repaired");
    }]);
    await session.prompt("Continue without retrying the operation");
    for (const entry of original) {
      expect(manager.getEntry(entry.id)).toEqual(entry);
    }
  });
});
