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
afterEach(async () => {
  await userSession?.dispose();
  userSession = undefined;
  vi.restoreAllMocks();
  if (directory) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** Exercise Bryti's resource-loader overrides and permissions with a real SDK and scripted provider. */
describe("Bryti session loading", () => {
  it("keeps native search usable and wraps deferred extension execution", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-agent-load-"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled"));
    const agentDir = path.join(directory, ".pi");
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"), refreshOnCreate: false });
    const faux = fauxProvider();
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.getModel().provider, "offline-test");
    infrastructure = { modelRuntime: runtime, modelRegistry: new ModelRegistry(runtime), agentDir };
    const extension = path.join(directory, "records.mjs");
    fs.writeFileSync(extension, `export default (pi) => pi.registerTool({
      name: "contract_record", label: "Record", description: "Write a fixture record",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      execute: async (_id, args) => ({ content: [{ type: "text", text: args.value }], details: {} })
    });`);
    const model = faux.getModel();
    const config = {
      data_dir: directory,
      agent: { name: "Test", model: `${model.provider}/${model.id}`, thinking_level: "off", timezone: "UTC", fallback_models: [] },
      models: { providers: [] }, tools: { workers: { max_concurrent: 1 },
        web_search: { enabled: false }, fetch_url: { timeout_ms: 1000, require_https: true, backend: "readability" } },
      agent_def: { ...PERSONAL_ASSISTANT_DEFAULTS, extension_files: [extension], skill_files: [] },
      telegram: { allowed_users: [] }, whatsapp: { enabled: false }, integrations: {}, cron: [],
      trust: { approved_tools: [] },
    } as Config;
    const approval = vi.fn().mockResolvedValue("allow_once");
    userSession = await loadUserSession(config, createCoreMemory(directory), "owner", [], undefined, "owner", {
      trustStore: createTrustStore(directory),
      context: { config, getLastUserMessage: () => "write a record", onApprovalNeeded: approval,
        evaluateToolCall: async () => ({ verdict: "ASK", reason: "Confirm" }) },
    });
    expect(userSession.extensionErrors).toEqual([]);
    expect(userSession.session.getActiveToolNames()).toContain("tool_search");
    expect(userSession.session.getActiveToolNames()).not.toContain("contract_record");
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
});
