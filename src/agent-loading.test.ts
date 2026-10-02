import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelInfra } from "./model-infra.js";
import { PERSONAL_ASSISTANT_DEFAULTS, type Config } from "./config.js";
import { createCoreMemory } from "./memory/core-memory.js";
import { createTrustStore } from "./trust/store.js";
import { createGoogleTools } from "./integrations/google-tools.js";

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

import { loadUserSession, refreshSystemPrompt, type UserSession } from "./agent.js";
import { Type } from "typebox";

let directory: string;
let userSession: UserSession | undefined;
afterEach(async () => {
  await userSession?.dispose();
  userSession = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (directory) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** Exercise Bryti's resource-loader overrides and permissions with a real SDK and scripted provider. */
describe("Bryti session loading", () => {
  it.each([false, true])("keeps discovery and approval wrappers usable with native Google opt-in %s", async (nativeGoogle) => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-agent-load-"));
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
    const agentDir = path.join(directory, ".pi");
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"), refreshOnCreate: false });
    const faux = fauxProvider();
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.getModel().provider, "offline-test");
    infrastructure = { modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), agentDir };
    const extension = path.join(directory, "records.mjs");
    fs.writeFileSync(extension, `export default (pi) => {
      pi.registerTool({
        name: "contract_record", label: "Record", description: "Write a fixture record",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        execute: async (_id, args) => ({ content: [{ type: "text", text: args.value }], details: {} })
      });
      for (const name of ["google_calendar_list", "google_oauth_setup"]) {
        pi.registerTool({ name, label: name, description: "Legacy Google fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "Legacy credential path" }], details: {} })
        });
      }
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
    if (nativeGoogle) {
      config.google = { users: { owner: { default_account: "personal" } } };
    }
    const approval = vi.fn().mockResolvedValue("allow_once");
    userSession = await loadUserSession(config, createCoreMemory(directory), "owner", createGoogleTools(config, "owner"), undefined, "owner", {
      trustStore: createTrustStore(directory),
      context: { config, getLastUserMessage: () => "write a record", onApprovalNeeded: approval,
        evaluateToolCall: async () => ({ verdict: "ASK", reason: "Confirm" }) },
    });
    expect(userSession.extensionErrors).toEqual([]);
    expect(userSession.session.getActiveToolNames()).toContain("tool_search");
    expect(userSession.session.getActiveToolNames()).not.toContain("contract_record");
    if (nativeGoogle) {
      expect(userSession.session.getToolDefinition("google_oauth_setup")).toBeUndefined();
      expect(userSession.session.getToolDefinition("google_calendar_list")?.parameters)
        .toMatchObject({ properties: { account: { type: "string" } } });
      expect(userSession.session.getAllTools().some((tool) => tool.description === "Legacy Google fixture")).toBe(false);
    } else {
      expect(userSession.session.getToolDefinition("google_oauth_setup")?.description).toBe("Legacy Google fixture");
      expect(userSession.session.getToolDefinition("google_calendar_list")?.description).toBe("Legacy Google fixture");
    }
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("tool_search", { query: "fixture record" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("contract_record", { value: "confirmed" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done"),
    ]);
    await userSession.session.prompt("Write a record");
    expect(approval).toHaveBeenCalledOnce();
    expect(userSession.session.messages.find((message) => message.role === "toolResult" && message.toolName === "contract_record"))
      .toMatchObject({ isError: false, content: [{ type: "text", text: "confirmed" }] });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("persists only changing prompt sections and recovers shortened reads after restart", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-context-load-"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
    const agentDir = path.join(directory, ".pi");
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"), refreshOnCreate: false });
    const faux = fauxProvider();
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.getModel().provider, "offline-test");
    infrastructure = { modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), agentDir };
    const model = faux.getModel();
    const config = { data_dir: directory,
      agent: { system_prompt: "Standing instructions", model: `${model.provider}/${model.id}`, thinking_level: "off", timezone: "UTC" },
      models: { providers: [] }, integrations: {},
      agent_def: { ...PERSONAL_ASSISTANT_DEFAULTS, extension_files: [], skill_files: [],
        prompt_sections: PERSONAL_ASSISTANT_DEFAULTS.prompt_sections.filter((section) => section !== "first_conversation") },
      context_management: { enabled: true, min_chars: 1000, keep_chars: 400, keep_recent_turns: 1 },
    } as unknown as Config;
    const memory = createCoreMemory(directory);
    memory.append("Owner", "Original fact");
    const original = "Untrusted evidence ".repeat(200);
    const readTool = { name: "read", label: "Read", description: "Read fixture", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: original }], details: {} }) };
    userSession = await loadUserSession(config, memory, "owner", [readTool]);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Read complete")]);
    await userSession.session.prompt("Read fixture");
    const entry = userSession.session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult")!;
    const reload = vi.spyOn(userSession.session, "reload");
    memory.append("Owner", "Updated fact");
    await refreshSystemPrompt(userSession.session);
    faux.setResponses([fauxAssistantMessage("Next answer")]);
    await userSession.session.prompt("Continue");
    expect(reload).not.toHaveBeenCalled();
    const patches = userSession.session.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "system");
    expect(patches.some((entry) => entry.type === "message" && entry.message.role === "system" &&
      entry.message.sections?.bryti_memory?.includes("Updated fact") && !entry.message.sections?.preamble)).toBe(true);
    faux.setResponses([fauxAssistantMessage("Another answer")]);
    await userSession.session.prompt("Another request");
    expect(userSession.session.sessionManager.getEntries().some((candidate) => candidate.type === "context_edit" && candidate.targetId === entry.id)).toBe(true);
    await userSession.dispose();
    config.context_management!.enabled = false;
    userSession = await loadUserSession(config, memory, "owner", [readTool]);
    expect(userSession.session.getActiveToolNames()).toContain("context_result_read");
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).not.toContain(original);
        return fauxAssistantMessage(fauxToolCall("codemode", {
          code: `const result = await tools.context_result_read({entry_id: ${JSON.stringify(entry.id)}}); console.log(result);`,
        }), { stopReason: "toolUse" });
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(original);
        return fauxAssistantMessage("Recovered without repeating the read");
      },
    ]);
    await userSession.session.prompt("Recover the original evidence");
    const trace = fs.readFileSync(path.join(directory, "logs", "diagnostics.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(trace.some((row) => row.tool_name === "context_result_read" && row.parent_tool_call_id && row.outcome === "success")).toBe(true);
    expect(JSON.stringify(trace)).not.toContain(original);
  });
});
