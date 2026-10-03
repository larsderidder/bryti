import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SettingsManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ModelInfra } from "./model-infra.js";
import { PERSONAL_ASSISTANT_DEFAULTS, type Config } from "./config.js";
import { createCoreMemory } from "./memory/core-memory.js";
import { createTrustStore } from "./trust/store.js";
import type { GuardrailInput, GuardrailResult } from "./trust/guardrail.js";
import { getSessionKey } from "./threads.js";
import { importTopicDeliveries } from "./channels/topic-delivery.js";

let infrastructure: ModelInfra;
vi.mock("./model-infra.js", async (importActual) => {
  const actual = await importActual<typeof import("./model-infra.js")>();
  return {
    ...actual,
    createModelInfra: async () => infrastructure,
    createBrytiSettingsManager: () => SettingsManager.inMemory({
      packages: [], retry: { enabled: false }, compaction: { enabled: false },
    }),
  };
});

import { loadUserSession, type UserSession } from "./agent.js";

let directory: string;
let userSession: UserSession | undefined;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-codemode-"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
});
afterEach(async () => {
  await userSession?.dispose();
  userSession = undefined;
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

/** Exercise native codemode through Bryti's loader with real sandbox execution and no model inference. */
async function setup(userId = "owner") {
  const agentDir = path.join(directory, ".pi");
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"), refreshOnCreate: false });
  const faux = fauxProvider();
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey(faux.getModel().provider, "offline-test");
  infrastructure = { modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), agentDir };
  const extension = path.join(directory, "records.mjs");
  const executions = path.join(directory, "executions.jsonl");
  fs.writeFileSync(extension, `import fs from "node:fs";
export default (pi) => {
  pi.registerTool({
    name: "contract_rows", label: "Rows", description: "Read fixture records",
    parameters: { type: "object", properties: { filter: { type: "string" } }, required: ["filter"] },
    outputSchema: { type: "object", properties: { rows: { type: "array", items: { type: "object" } } } },
    execute: async (_id, args) => {
      fs.appendFileSync(${JSON.stringify(executions)}, JSON.stringify(args) + "\\n");
      return { content: [{ type: "text", text: "RAW_ROW_DATA" }], details: {},
        structuredContent: { rows: [
          { id: "selected", included: true, body: "RAW_ROW_DATA" },
          { id: "excluded", included: false, body: "RAW_ROW_DATA" }
        ] } };
    }
  });
  pi.registerTool({
    name: "contract_quarantined", label: "Invalid", description: "Unsupported fixture schema",
    parameters: { type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } } },
    execute: async () => { throw new Error("Quarantined tool executed"); }
  });
  pi.registerTool({
    name: "telegram_forum_topic_send", label: "Send", description: "Offline topic sender",
    parameters: { type: "object", properties: { chat_id: { type: "string" },
      message_thread_id: { type: "number" }, text: { type: "string" } },
      required: ["chat_id", "message_thread_id", "text"] },
    execute: async (_id, args) => ({ content: [{ type: "text", text: JSON.stringify({
      ok: true, chat_id: args.chat_id, message_thread_id: args.message_thread_id, message_id: 349
    }) }], details: {} })
  });
};`);
  const model = faux.getModel();
  const config = {
    data_dir: directory,
    agent: { name: "Test", model: `${model.provider}/${model.id}`, thinking_level: "off", timezone: "UTC", fallback_models: [] },
    models: { providers: [] }, tools: { workers: { max_concurrent: 1 },
      web_search: { enabled: false }, fetch_url: { timeout_ms: 1000, require_https: true, backend: "readability" } },
    agent_def: { ...PERSONAL_ASSISTANT_DEFAULTS, extension_files: [extension], skill_files: [] },
    telegram: { allowed_users: [] }, whatsapp: { enabled: false }, integrations: {}, cron: [],
    trust: { approved_tools: [] },
  } as unknown as Config;
  const approval = vi.fn().mockResolvedValue("allow");
  const evaluate = vi.fn<(input: GuardrailInput) => Promise<GuardrailResult>>().mockResolvedValue({ verdict: "ASK", reason: "Confirm records" });
  const store = createTrustStore(directory);
  const load = async (sessionKey = userId) => {
    userSession = await loadUserSession(config, createCoreMemory(directory), userId, [], undefined, sessionKey, {
      trustStore: store,
      context: { config, getLastUserMessage: () => "Process records", onApprovalNeeded: approval,
        evaluateToolCall: evaluate },
    });
    return userSession.session;
  };
  const session = await load();
  return { session, faux, approval, evaluate, store, load, executions, config };
}

function script(code: string) {
  return fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
}

describe("Bryti codemode", () => {
  it("runs repeated guardrail-allowed deferred reads without an availability approval", async () => {
    const { session, faux, approval, evaluate } = await setup();
    evaluate.mockResolvedValue({ verdict: "ALLOW", reason: "routine read within operating guidelines" });
    faux.setResponses([
      script('await tools.contract_rows({filter: "first"}); await tools.contract_rows({filter: "second"}); text("Read both");'),
      fauxAssistantMessage("Done"),
    ]);
    await session.prompt("Continue the standing read task");

    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(approval).not.toHaveBeenCalled();
    expect(session.getLastAssistantText()).toBe("Done");
  });
  it("is active alongside direct tools, without exposing classifiers or treating it as an editable extension", async () => {
    const { session, faux, approval } = await setup();
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["codemode", "tool_search", "read"]));
    expect(session.getActiveToolNames()).not.toContain("contract_rows");
    expect(session.systemPrompt).not.toMatch(/- codemode:.*\(extension\)/);
    await session.reload();
    expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["codemode", "tool_search", "read"]));
    faux.setResponses([
      (context) => {
        expect(getCurrentSystemMessage(context.messages)?.toolsAdded?.map((tool) => tool.name))
          .toEqual(expect.arrayContaining(["codemode", "read"]));
        return script('text(typeof models); text(typeof tools.read);');
      },
      fauxAssistantMessage("Done"),
    ]);
    await session.prompt("Check available interfaces");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    expect(result).toMatchObject({ isError: false });
    expect(JSON.stringify(result)).toContain("undefined");
    expect(JSON.stringify(result)).toContain("function");
    expect(session.getLastAssistantText()).toBe("Done");
    expect(approval).not.toHaveBeenCalled();
  });

  it("filters structured deferred results outside provider context while preserving approvals and nested audit events", async () => {
    const { session, faux, approval, evaluate } = await setup();
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    faux.setResponses([
      script('const result = await tools.contract_rows({filter: "all"}); text(result.rows.filter(row => row.included).map(row => row.id));'),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("selected");
        expect(JSON.stringify(context.messages)).not.toContain("RAW_ROW_DATA");
        expect(context.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
        return fauxAssistantMessage("Selected record");
      },
    ]);
    await session.prompt("Select relevant records");
    expect(session.getLastAssistantText()).toBe("Selected record");
    expect(approval).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ toolName: "contract_rows", args: JSON.stringify({ filter: "all" }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_start", toolName: "contract_rows", parentToolCallId: expect.any(String) }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", toolName: "contract_rows", isError: false }));
    const audit = fs.readFileSync(path.join(directory, "logs", "tool-calls.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.map((entry) => entry.toolName)).toEqual(["codemode", "contract_rows"]);
    expect(session.getActiveToolNames()).not.toContain("contract_rows");
  });

  it("composes native deferred MCP tools through the same approval boundary", async () => {
    const userDirectory = path.join(directory, "users", "owner");
    fs.mkdirSync(userDirectory, { recursive: true });
    fs.writeFileSync(path.join(userDirectory, "mcp.json"), JSON.stringify({ mcpServers: {
      contract: { command: process.execPath,
        args: [fileURLToPath(new URL("./tools/__fixtures__/mcp-server.mjs", import.meta.url))] },
    } }));
    const { session, faux, approval } = await setup();
    faux.setResponses([
      script('const result = await tools.mcp__contract__write({value: "saved"}); text(result.structuredContent.writes);'),
      fauxAssistantMessage("MCP record written"),
    ]);
    await session.prompt("Write through MCP and return only the write count");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    expect(result).toMatchObject({ isError: false, content: expect.arrayContaining([{ type: "text", text: "1" }]) });
    expect(session.getLastAssistantText()).toBe("MCP record written");
    expect(approval).toHaveBeenCalledOnce();
    expect(session.getActiveToolNames()).not.toContain("mcp__contract__write");
  });

  it("records confirmed nested topic sends even when the script discards their receipts", async () => {
    const { session, faux, config, approval, load } = await setup("12345");
    const chatId = "-1003987750931";
    config.telegram.mode = "group";
    config.telegram.allowed_users = [12345];
    config.telegram.allowed_groups = [Number(chatId)];
    faux.setResponses([
      script(`await tools.telegram_forum_topic_send({chat_id: "${chatId}", message_thread_id: 32, text: "Selected records"}); text("Sent");`),
      fauxAssistantMessage("Posted"),
    ]);
    await session.prompt("Post the selected records in the other topic");
    expect(approval).toHaveBeenCalledOnce();
    expect(session.getLastAssistantText()).toBe("Posted");
    await userSession!.dispose();
    const threadId = "telegram-topic-1003987750931-32";
    const destination = await load(getSessionKey("12345", threadId));
    const acknowledge = await importTopicDeliveries(directory, "12345", threadId, destination);
    expect(destination.sessionManager.getBranch()).toContainEqual(expect.objectContaining({
      type: "custom_message", customType: "bryti-topic-delivery",
      details: expect.objectContaining({ text: "Selected records", messageId: "349" }),
    }));
    faux.setResponses([(context) => {
      expect(JSON.stringify(context.messages)).toContain("Selected records");
      return fauxAssistantMessage("Message received");
    }]);
    await destination.prompt("Follow up on the posted records");
    expect(destination.getLastAssistantText()).toBe("Message received");
    expect(approval).toHaveBeenCalledOnce();
    acknowledge();
  });

  it("rejects invalid arguments and quarantined tools, and cannot bypass a blocked leaf operation", async () => {
    const { session, faux, approval, evaluate, executions } = await setup();
    evaluate.mockResolvedValue({ verdict: "BLOCK", reason: "Denied fixture operation" });
    faux.setResponses([
      script(`const invalid = await Promise.allSettled([
        tools.contract_rows({}),
        Promise.resolve().then(() => tools.contract_quarantined({value: "x"}))
      ]); text(invalid.map(result => result.status));
      text(await tools.contract_rows({filter: "blocked"}));`),
      fauxAssistantMessage("No operation performed"),
    ]);
    await session.prompt("Try disallowed operations");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    expect(JSON.stringify(result)).toContain('[\\"rejected\\",\\"rejected\\"]');
    expect(JSON.stringify(result)).toContain("Blocked:");
    expect(evaluate).toHaveBeenCalledOnce();
    expect(approval).not.toHaveBeenCalled();
    expect(fs.existsSync(executions)).toBe(false);
  });

  it("persists script state across restart without replaying nested tools", async () => {
    const { session, faux, approval, load, executions } = await setup();
    faux.setResponses([
      script('const result = await tools.contract_rows({filter: "all"}); store("selection", result.rows.map(row => row.id)); text("Saved selection");'),
      fauxAssistantMessage("Saved"),
    ]);
    await session.prompt("Save records for later processing");
    await userSession!.dispose();
    const resumed = await load();
    faux.setResponses([script('text(load("selection"));'), fauxAssistantMessage("Selection restored")]);
    await resumed.prompt("Continue processing the saved selection");
    expect(resumed.getActiveToolNames()).toContain("codemode");
    expect(JSON.stringify(resumed.messages)).toContain('[\\"selected\\",\\"excluded\\"]');
    expect(approval).toHaveBeenCalledOnce();
    expect(fs.readFileSync(executions, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("reports partial failures without rolling back or replaying completed leaf operations", async () => {
    const { session, faux, approval, executions } = await setup();
    faux.setResponses([
      script('text(await tools.contract_rows({filter: "all"})); store("unfinished", true); throw new Error("Fixture failure");'),
      fauxAssistantMessage("The script failed after reading records"),
    ]);
    await session.prompt("Run a failing workflow");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("Fixture failure");
    expect(JSON.stringify(result)).toContain("contract_rows (ok)");
    faux.setResponses([script('text(load("unfinished"));'), fauxAssistantMessage("Not saved")]);
    await session.prompt("Check whether the failed script saved state");
    expect(approval).toHaveBeenCalledOnce();
    expect(fs.readFileSync(executions, "utf8").trim().split("\n")).toHaveLength(1);
    expect(session.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "codemode-store")).toBe(false);
  });

  it("aborts a pending nested approval without executing or granting the operation", async () => {
    const { session, faux, approval, store, executions } = await setup();
    const entered = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<"allow_always">();
    approval.mockImplementation(() => {
      entered.resolve();
      return decision.promise;
    });
    faux.setResponses([script('await tools.contract_rows({filter: "all"});')]);
    const prompt = session.prompt("Ask before processing records");
    await Promise.race([entered.promise, prompt.then(() => { throw new Error("Prompt ended before requesting approval"); })]);
    await session.abort();
    await prompt;
    decision.resolve("allow_always");
    await Promise.resolve();
    expect(fs.existsSync(executions)).toBe(false);
    expect(store.listApproved()).toEqual([]);
    faux.setResponses([script('text("Still usable");'), fauxAssistantMessage("Recovered")]);
    await session.prompt("Continue after cancellation");
    expect(session.getLastAssistantText()).toBe("Recovered");
  });
});
