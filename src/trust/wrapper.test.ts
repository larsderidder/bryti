import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  createTrustStore,
  registerToolCapabilities,
  checkPendingApproval,
} from "./store.js";
import { wrapToolWithTrustCheck, wrapToolsWithTrustChecks, type ApprovalCallback } from "./wrapper.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-wrap-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTool(name: string, returnText: string): AgentTool<any> {
  return {
    name,
    label: name,
    description: `Test tool: ${name}`,
    parameters: Type.Object({}),
    async execute(): Promise<AgentToolResult<unknown>> {
      return { content: [{ type: "text", text: returnText }] };
    },
  };
}

describe("wrapToolWithTrustCheck", () => {
  it("allows Safe tools to execute normally", async () => {
    const tool = makeTool("memory_core_append", "saved");
    const store = createTrustStore(tmpDir);
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1");

    const result = await wrapped.execute("call1", {});
    expect(result.content[0].text).toBe("saved");
  });

  it("blocks unapproved Elevated tools", async () => {
    registerToolCapabilities("test_elevated", {
      level: "elevated",
      capabilities: ["network"],
    });
    const tool = makeTool("test_elevated", "should not run");
    const store = createTrustStore(tmpDir);
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1");

    const result = await wrapped.execute("call1", {});
    expect(result.content[0].text).toContain("Permission required");
  });

  it("allows pre-approved Elevated tools", async () => {
    registerToolCapabilities("test_preapproved", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const tool = makeTool("test_preapproved", "executed");
    const store = createTrustStore(tmpDir, ["test_preapproved"]);
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1");

    const result = await wrapped.execute("call1", {});
    expect(result.content[0].text).toBe("executed");
  });

  it("sets pending approval when blocked", async () => {
    registerToolCapabilities("test_pending", {
      level: "elevated",
      capabilities: ["network"],
    });
    const tool = makeTool("test_pending", "nope");
    const store = createTrustStore(tmpDir);
    const wrapped = wrapToolWithTrustCheck(tool, store, "user2");

    await wrapped.execute("call1", {});

    // Pending approval should be set
    const approved = checkPendingApproval("user2", "yes");
    expect(approved).toBe("test_pending");
  });

  it("full approval flow: block -> user approves -> retry succeeds", async () => {
    registerToolCapabilities("test_flow", {
      level: "elevated",
      capabilities: ["network"],
    });
    const tool = makeTool("test_flow", "success");
    const store = createTrustStore(tmpDir);
    const wrapped = wrapToolWithTrustCheck(tool, store, "user3");

    // First call: blocked
    const result1 = await wrapped.execute("call1", {});
    expect(result1.content[0].text).toContain("Permission required");

    // User says "always"
    const pending = checkPendingApproval("user3", "always");
    expect(pending).toBe("test_flow");
    store.approve("test_flow", "always");

    // Retry: succeeds
    const result2 = await wrapped.execute("call2", {});
    expect(result2.content[0].text).toBe("success");
  });
});

describe("inline approval callback", () => {
  it("calls onApprovalNeeded and executes when allowed", async () => {
    registerToolCapabilities("test_inline_allow", {
      level: "elevated",
      capabilities: ["network"],
      reason: "Makes HTTP requests.",
    });
    const tool = makeTool("test_inline_allow", "executed");
    const store = createTrustStore(tmpDir);

    const approvalCallback: ApprovalCallback = async (_prompt, _key) => "allow";
    const wrapped = wrapToolWithTrustCheck(tool, store, "userA", {
      config: { tools: { web_search: { enabled: false, searxng_url: "" }, fetch_url: { enabled: false, timeout_ms: 0 }, files: { enabled: false, base_dir: "" }, workers: { max_concurrent: 0 } }, integrations: {}, agent: { name: "", system_prompt: "", model: "", fallback_models: [] }, telegram: { token: "", allowed_users: [] }, whatsapp: { enabled: false, allowed_users: [] }, models: { providers: [] }, cron: [], trust: { approved_tools: [] }, data_dir: tmpDir } as any,
      getLastUserMessage: () => undefined,
      onApprovalNeeded: approvalCallback,
    });

    const result = await wrapped.execute("call1", {});
    expect(result.content[0].text).toBe("executed");
  });

  it("calls onApprovalNeeded and blocks when denied", async () => {
    registerToolCapabilities("test_inline_deny", {
      level: "elevated",
      capabilities: ["shell"],
      reason: "Runs shell commands.",
    });
    const tool = makeTool("test_inline_deny", "should not run");
    const store = createTrustStore(tmpDir);

    const approvalCallback: ApprovalCallback = async (_prompt, _key) => "deny";
    const wrapped = wrapToolWithTrustCheck(tool, store, "userB", {
      config: {} as any,
      getLastUserMessage: () => undefined,
      onApprovalNeeded: approvalCallback,
    });

    const result = await wrapped.execute("call1", {});
    expect(result.content[0].text).toContain("denied");
  });

  it("persists always-approval to trust store", async () => {
    registerToolCapabilities("test_inline_always", {
      level: "elevated",
      capabilities: ["network"],
    });
    const tool = makeTool("test_inline_always", "executed");
    const store = createTrustStore(tmpDir);

    const approvalCallback: ApprovalCallback = async (_prompt, _key) => "allow_always";
    const wrapped = wrapToolWithTrustCheck(tool, store, "userC", {
      config: {} as any,
      getLastUserMessage: () => undefined,
      onApprovalNeeded: approvalCallback,
    });

    await wrapped.execute("call1", {});
    expect(store.isApproved("test_inline_always")).toBe(true);
  });
});

describe("wrapToolsWithTrustChecks", () => {
  it("wraps all tools in the array", async () => {
    registerToolCapabilities("elevated_a", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const safe = makeTool("safe_tool", "ok");
    const elevated = makeTool("elevated_a", "blocked");
    const store = createTrustStore(tmpDir);

    const wrapped = wrapToolsWithTrustChecks([safe, elevated], store, "user4");
    expect(wrapped).toHaveLength(2);

    const safeResult = await wrapped[0].execute("c1", {});
    expect(safeResult.content[0].text).toBe("ok");

    const elevatedResult = await wrapped[1].execute("c2", {});
    expect(elevatedResult.content[0].text).toContain("Permission required");
  });
});
