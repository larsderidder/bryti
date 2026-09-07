import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime,
  SessionManager, SettingsManager, type AgentSession, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createTrustStore, registerToolCapabilities, wrapToolWithTrustCheck } from "./trust/index.js";
import type { Config } from "./config.js";

/** Real SDK sessions with scripted provider output. No network or model inference. */
describe("Pi SDK integration contracts", () => {
  let directory: string;
  const sessions: AgentSession[] = [];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-sdk-contract-"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in SDK contract tests"));
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.abort();
      session.dispose();
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function setup(tools: ToolDefinition[] = [], manager = SessionManager.inMemory(directory)) {
    const agentDir = path.join(directory, "agent");
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"),
      refreshOnCreate: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.getModel().provider, "offline-test");
    const settings = SettingsManager.inMemory({
      packages: [], defaultTools: [], retry: { enabled: false },
      compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 256 },
    });
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, systemPrompt: "Offline SDK contract test.",
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: directory, agentDir, modelRuntime: runtime, model: faux.getModel(),
      thinkingLevel: "off", customTools: tools, tools: tools.map((tool) => tool.name),
      sessionManager: manager, settingsManager: settings, resourceLoader: loader,
    });
    sessions.push(session);
    return { session, faux, manager };
  }

  function echoTool() {
    return defineTool({
      name: "contract_echo", label: "Echo", description: "Return the supplied value",
      parameters: Type.Object({ value: Type.String() }),
      execute: vi.fn(async (_id, params) => ({ content: [{ type: "text" as const, text: params.value }], details: {} })),
    });
  }

  it("persists custom tool results and reopens the same conversation", async () => {
    const tool = echoTool();
    const manager = SessionManager.create(directory, path.join(directory, "sessions"));
    const first = await setup([tool], manager);
    first.faux.setResponses([
      fauxAssistantMessage(fauxToolCall(tool.name, { value: "stored result" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished"),
    ]);
    await first.session.prompt("Use the echo tool");
    expect(tool.execute).toHaveBeenCalledOnce();
    const file = first.session.sessionFile!;
    first.session.dispose();
    sessions.splice(sessions.indexOf(first.session), 1);

    const reopened = await setup([tool], SessionManager.open(file));
    expect(reopened.session.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(reopened.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
      toolName: tool.name, isError: false, content: [{ type: "text", text: "stored result" }],
    });
    reopened.faux.setResponses([fauxAssistantMessage("Still here")]);
    await reopened.session.prompt("Continue");
    expect(reopened.session.getLastAssistantText()).toBe("Still here");
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("activates a deferred custom tool in a worker-like in-memory session", async () => {
    const tool = echoTool();
    const { session, faux } = await setup([tool]);
    session.setActiveToolsByName([]);
    expect(session.getActiveToolNames()).not.toContain(tool.name);
    session.setActiveToolsByName([tool.name]);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(tool.name, { value: "worker result" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Worker complete"),
    ]);
    await session.prompt("Do the work");
    expect(session.sessionFile).toBeUndefined();
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(session.isStreaming).toBe(false);
    expect(session.getLastAssistantText()).toBe("Worker complete");
  });

  it("can prompt again after a provider error without replaying the failed turn", async () => {
    const { session, faux } = await setup();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Scripted provider failure" })]);
    await session.prompt("First request");
    expect(session.messages.at(-1)).toMatchObject({ stopReason: "error" });
    faux.setResponses([fauxAssistantMessage("Recovered")]);
    await session.prompt("Second request");
    expect(session.getLastAssistantText()).toBe("Recovered");
    expect(faux.state.callCount).toBe(2);
  });

  it("aborts while a Bryti approval is unresolved, without executing or granting", async () => {
    const tool = { ...echoTool(), execute: vi.fn(async () => ({ content: [], details: {} })) };
    registerToolCapabilities(tool.name, { level: "elevated" });
    const store = createTrustStore(directory, []);
    const entered = Promise.withResolvers<void>();
    const approval = Promise.withResolvers<"allow_always">();
    const wrapped = wrapToolWithTrustCheck(tool, store, "owner", {
      config: {} as Config,
      getLastUserMessage: () => "Ask before using this tool",
      evaluateToolCall: async () => ({ verdict: "ASK", reason: "Confirm exact arguments" }),
      onApprovalNeeded: () => { entered.resolve(); return approval.promise; },
    });
    const { session, faux } = await setup([wrapped]);
    faux.setResponses([fauxAssistantMessage(fauxToolCall(tool.name, { value: "must not run" }), { stopReason: "toolUse" })]);
    const prompt = session.prompt("Use the tool");
    await entered.promise;
    await session.abort();
    await prompt;
    approval.resolve("allow_always");
    await Promise.resolve();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(store.listApproved()).toEqual([]);
  });

  it("abort cancels and waits for an active compaction", async () => {
    const { session, faux, manager } = await setup();
    faux.setResponses([fauxAssistantMessage("First answer ".repeat(300)), fauxAssistantMessage("Second answer ".repeat(300))]);
    await session.prompt("First request ".repeat(300));
    await session.prompt("Second request ".repeat(300));
    const entered = Promise.withResolvers<void>();
    let aborted = false;
    const blocked: FauxResponseStep = (_context, options) => new Promise((resolve) => {
      const cancel = () => {
        aborted = true;
        resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
      };
      options?.signal?.addEventListener("abort", cancel, { once: true });
      entered.resolve();
      if (options?.signal?.aborted) {
        cancel();
      }
    });
    faux.setResponses([blocked, blocked]);
    const compacting = session.compact().catch((error: unknown) => error);
    await entered.promise;
    await session.abort();
    await compacting;
    expect(aborted).toBe(true);
    expect(session.isCompacting).toBe(false);
    expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    faux.setResponses([fauxAssistantMessage("Usable after abort")]);
    await session.prompt("Continue without retrying the compaction");
    expect(session.getLastAssistantText()).toBe("Usable after abort");
  });
});
