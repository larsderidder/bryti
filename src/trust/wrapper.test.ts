import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  createTrustStore,
  registerToolCapabilities,
  checkPendingApproval,
} from "./store.js";
import { wrapToolWithTrustCheck, wrapToolsWithTrustChecks, type ApprovalCallback } from "./wrapper.js";
import type { GuardrailResult } from "./guardrail.js";
import type { Config } from "../config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-wrap-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): Config {
  return {
    tools: {
      web_search: { enabled: false, searxng_url: "" },
      fetch_url: { enabled: false, timeout_ms: 0, backend: "readability", require_https: true },
      workers: { max_concurrent: 0, default_timeout_seconds: 60, thinking_level: "medium", types: {} },
    },
    integrations: {},
    agent: { name: "", system_prompt: "", model: "test/model", fallback_models: [] },
    telegram: { token: "", mode: "dm", allowed_users: [], allowed_groups: [] },
    whatsapp: { enabled: false, allowed_users: [] },
    threema: { enabled: false, gateway_id: "", secret: "", private_key_path: "", allowed_senders: [], api_base_url: "https://msgapi.threema.ch", callback: { host: "127.0.0.1", port: 8787, path: "/threema/callback" } },
    web_e2ee: { enabled: false, listen_host: "", listen_port: 0, public_origin: "", allowed_origins: [], path_prefix: "/", pairing: { invite_ttl_minutes: 10 } },
    models: { providers: [] },
    cron: [],
    memory: { embeddings: { provider: "local", timeout_ms: 1000 }, reflection: true, daily_review: true, compaction: "conversational" },
    voice: { enabled: false, transcribe_command: [], synthesize_command: [], reply_with_voice: true, keep_temp_files: false, command_timeout_ms: 1000, synthesized_audio_extension: ".ogg", max_tts_chars: 2500 },
    trust: { approved_tools: [] },
    agent_def: { tool_groups: [], prompt_sections: [], tone: "conversational", memory: { reflection: true, daily_review: true, compaction: "conversational" }, extension_files: [], skill_files: [] },
    data_dir: tmpDir,
  };
}

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

function makeCountingTool(name: string, calls: string[]): AgentTool<any> {
  return {
    name,
    label: name,
    description: `Test tool: ${name}`,
    parameters: Type.Object({}),
    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      calls.push(JSON.stringify(params));
      return { content: [{ type: "text", text: "executed" }] };
    },
  };
}

function allowGuardrail(calls: unknown[]): (input: any) => Promise<GuardrailResult> {
  return async (input) => {
    calls.push(input);
    return { verdict: "ALLOW", reason: "safe test operation" };
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

  it("blocks unapproved Elevated tools without inline approval", async () => {
    registerToolCapabilities("test_elevated", {
      level: "elevated",
      capabilities: ["network"],
    });
    const tool = makeTool("test_elevated", "should not run");
    const store = createTrustStore(tmpDir);
    const guardrailCalls: unknown[] = [];
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "send it",
      evaluateToolCall: allowGuardrail(guardrailCalls),
    });

    const result = await wrapped.execute("call1", { url: "https://example.com" });
    expect(result.content[0].text).toContain("Permission required");
    expect(guardrailCalls).toHaveLength(1);
  });

  it("sets pending approval when blocked without inline approval", async () => {
    registerToolCapabilities("test_pending", {
      level: "elevated",
      capabilities: ["network"],
    });
    const tool = makeTool("test_pending", "nope");
    const store = createTrustStore(tmpDir);
    const wrapped = wrapToolWithTrustCheck(tool, store, "user2", {
      config: makeConfig(),
      getLastUserMessage: () => undefined,
      evaluateToolCall: async () => ({ verdict: "ALLOW", reason: "safe" }),
    });

    await wrapped.execute("call1", { url: "https://example.com" });

    const approved = checkPendingApproval("user2", "yes");
    expect(approved).toBe("test_pending");
  });

  it("checks guardrail on the first inline approval and shows actual sanitized arguments", async () => {
    registerToolCapabilities("test_inline_first", {
      level: "elevated",
      capabilities: ["network"],
      reason: "Makes HTTP requests.",
    });
    const tool = makeTool("test_inline_first", "executed");
    const store = createTrustStore(tmpDir);
    const prompts: string[] = [];
    const guardrailCalls: unknown[] = [];
    const approvalCallback: ApprovalCallback = async (prompt) => {
      prompts.push(prompt);
      return "allow";
    };
    const wrapped = wrapToolWithTrustCheck(tool, store, "userA", {
      config: makeConfig(),
      getLastUserMessage: () => "post the webhook",
      onApprovalNeeded: approvalCallback,
      evaluateToolCall: allowGuardrail(guardrailCalls),
      source: { threadId: "main", platform: "telegram", channelId: "123" },
    });

    const result = await wrapped.execute("call1", {
      method: "POST",
      url: "https://hooks.example.com/abc",
      token: "secret-token-value",
    });

    expect(result.content[0].text).toBe("executed");
    expect(guardrailCalls).toHaveLength(1);
    expect(prompts[0]).toContain("test_inline_first");
    expect(prompts[0]).toContain("https://hooks.example.com/abc");
    expect(prompts[0]).toContain("token");
    expect(prompts[0]).not.toContain("secret-token-value");
    expect(prompts[0]).toContain("30 days");
    expect(prompts[0]).toContain("topic");
  });

  it("still guardrails legacy tool approval before executing unmatched arguments", async () => {
    registerToolCapabilities("test_legacy_tool", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const calls: string[] = [];
    const tool = makeCountingTool("test_legacy_tool", calls);
    const store = createTrustStore(tmpDir, ["test_legacy_tool"]);
    const guardrailCalls: unknown[] = [];
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "run tests",
      evaluateToolCall: allowGuardrail(guardrailCalls),
    });

    await wrapped.execute("call1", { command: "npm test" });

    expect(calls).toHaveLength(1);
    expect(guardrailCalls).toHaveLength(1);
  });


  it("consumes legacy one-time availability after a guardrail allow", async () => {
    registerToolCapabilities("test_legacy_once", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const calls: string[] = [];
    const tool = makeCountingTool("test_legacy_once", calls);
    const store = createTrustStore(tmpDir);
    store.approve("test_legacy_once", "once", { userId: "user1" });
    const guardrailCalls: unknown[] = [];
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "run tests",
      evaluateToolCall: allowGuardrail(guardrailCalls),
    });

    await wrapped.execute("call1", { command: "npm test" });
    const result = await wrapped.execute("call2", { command: "npm test" });

    expect(calls).toHaveLength(1);
    expect(guardrailCalls).toHaveLength(2);
    expect(result.content[0].text).toContain("Permission required");
  });

  it("skips guardrail for matching exact argument grants", async () => {
    registerToolCapabilities("test_exact", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const calls: string[] = [];
    const tool = makeCountingTool("test_exact", calls);
    const store = createTrustStore(tmpDir);
    store.approveInvocation("test_exact", { command: "npm test" }, "always", { userId: "user1" });
    const guardrail = vi.fn(async () => ({ verdict: "BLOCK", reason: "would have blocked" }) as GuardrailResult);
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "run tests",
      evaluateToolCall: guardrail,
    });

    const result = await wrapped.execute("call1", { command: "npm test" });

    expect(result.content[0].text).toBe("executed");
    expect(calls).toHaveLength(1);
    expect(guardrail).not.toHaveBeenCalled();
  });

  it("does not use exact grants for unmatched arguments", async () => {
    registerToolCapabilities("test_exact_unmatched", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const calls: string[] = [];
    const tool = makeCountingTool("test_exact_unmatched", calls);
    const store = createTrustStore(tmpDir);
    store.approveInvocation("test_exact_unmatched", { command: "npm test" }, "always", { userId: "user1" });
    const guardrailCalls: unknown[] = [];
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "run the build",
      evaluateToolCall: allowGuardrail(guardrailCalls),
      onApprovalNeeded: async () => "allow",
    });

    await wrapped.execute("call1", { command: "npm run build" });

    expect(calls).toHaveLength(1);
    expect(guardrailCalls).toHaveLength(1);
  });

  it("consumes one-time exact grants once", async () => {
    registerToolCapabilities("test_exact_once", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const calls: string[] = [];
    const tool = makeCountingTool("test_exact_once", calls);
    const store = createTrustStore(tmpDir, ["test_exact_once"]);
    store.approveInvocation("test_exact_once", { command: "npm test" }, "once", { userId: "user1" });
    const guardrailCalls: unknown[] = [];
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "run tests",
      evaluateToolCall: allowGuardrail(guardrailCalls),
    });

    await wrapped.execute("call1", { command: "npm test" });
    await wrapped.execute("call2", { command: "npm test" });

    expect(calls).toHaveLength(2);
    expect(guardrailCalls).toHaveLength(1);
  });

  it("blocks when the guardrail blocks the first invocation", async () => {
    registerToolCapabilities("test_blocked", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const calls: string[] = [];
    const tool = makeCountingTool("test_blocked", calls);
    const store = createTrustStore(tmpDir, ["test_blocked"]);
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "clean up",
      evaluateToolCall: async () => ({ verdict: "BLOCK", reason: "dangerous command" }),
    });

    const result = await wrapped.execute("call1", { command: "rm -rf /" });

    expect(result.content[0].text).toContain("Blocked");
    expect(calls).toHaveLength(0);
  });

  it("persists exact always approval after guardrail ask", async () => {
    registerToolCapabilities("test_inline_always", {
      level: "elevated",
      capabilities: ["network"],
    });
    const tool = makeTool("test_inline_always", "executed");
    const store = createTrustStore(tmpDir);
    const approvalCallback: ApprovalCallback = async () => "allow_always";
    const wrapped = wrapToolWithTrustCheck(tool, store, "userC", {
      config: makeConfig(),
      getLastUserMessage: () => undefined,
      onApprovalNeeded: approvalCallback,
      evaluateToolCall: async () => ({ verdict: "ASK", reason: "needs confirmation" }),
    });

    await wrapped.execute("call1", { url: "https://example.com" });
    expect(store.hasToolApproval("test_inline_always")).toBe(true);
    expect(store.isInvocationApproved("test_inline_always", { url: "https://example.com" }, { userId: "userC", source: "agent" })).toBe(true);
    const [grant] = store.listApproved().filter((record) => record.kind === "invocation");
    expect(Date.parse(grant.expiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("does not execute if the signal aborts while guardrail is pending", async () => {
    registerToolCapabilities("test_abort_guardrail", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const calls: string[] = [];
    const tool = makeCountingTool("test_abort_guardrail", calls);
    const store = createTrustStore(tmpDir, ["test_abort_guardrail"]);
    const controller = new AbortController();
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "run tests",
      evaluateToolCall: async () => {
        controller.abort();
        return { verdict: "ALLOW", reason: "safe" };
      },
    });

    const result = await wrapped.execute("call1", { command: "npm test" }, controller.signal);

    expect(result.content[0].text).toContain("aborted");
    expect(calls).toHaveLength(0);
  });


  it("returns on abort while the guardrail promise stays unresolved", async () => {
    registerToolCapabilities("test_unresolved_guardrail_abort", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const calls: string[] = [];
    const tool = makeCountingTool("test_unresolved_guardrail_abort", calls);
    const store = createTrustStore(tmpDir, ["test_unresolved_guardrail_abort"]);
    const controller = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveGuardrail!: (value: GuardrailResult) => void;
    const guardrail = vi.fn(async () => {
      resolveStarted();
      return await new Promise<GuardrailResult>((resolve) => {
        resolveGuardrail = resolve;
      });
    });
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "run tests",
      evaluateToolCall: guardrail,
    });

    const execution = wrapped.execute("call1", { command: "npm test" }, controller.signal);
    await started;
    controller.abort();
    const result = await execution;
    resolveGuardrail({ verdict: "ALLOW", reason: "late allow" });
    await Promise.resolve();

    expect(result.content[0].text).toContain("aborted");
    expect(guardrail).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(0);
  });


  it("does not run the guardrail if the signal was already aborted", async () => {
    registerToolCapabilities("test_abort_before_guardrail", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const calls: string[] = [];
    const tool = makeCountingTool("test_abort_before_guardrail", calls);
    const store = createTrustStore(tmpDir, ["test_abort_before_guardrail"]);
    const controller = new AbortController();
    controller.abort();
    const guardrail = vi.fn(async () => ({ verdict: "ALLOW", reason: "safe" }) as GuardrailResult);
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "run tests",
      evaluateToolCall: guardrail,
    });

    const result = await wrapped.execute("call1", { command: "npm test" }, controller.signal);

    expect(result.content[0].text).toContain("aborted");
    expect(guardrail).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("does not execute if the signal aborts while approval is pending", async () => {
    registerToolCapabilities("test_abort_approval", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const calls: string[] = [];
    const tool = makeCountingTool("test_abort_approval", calls);
    const store = createTrustStore(tmpDir);
    const controller = new AbortController();
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "run tests",
      evaluateToolCall: async () => ({ verdict: "ASK", reason: "confirm command" }),
      onApprovalNeeded: async () => {
        controller.abort();
        return "allow";
      },
    });

    const result = await wrapped.execute("call1", { command: "npm test" }, controller.signal);

    expect(result.content[0].text).toContain("aborted");
    expect(calls).toHaveLength(0);
    expect(store.isInvocationApproved("test_abort_approval", { command: "npm test" }, { userId: "user1" })).toBe(false);
  });


  it("returns on abort while the approval promise stays unresolved", async () => {
    registerToolCapabilities("test_unresolved_approval_abort", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const calls: string[] = [];
    const tool = makeCountingTool("test_unresolved_approval_abort", calls);
    const store = createTrustStore(tmpDir);
    const controller = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveApproval!: (value: "allow_always") => void;
    const approvalCallback: ApprovalCallback = async () => {
      resolveStarted();
      return await new Promise((resolve) => {
        resolveApproval = resolve;
      });
    };
    const wrapped = wrapToolWithTrustCheck(tool, store, "user1", {
      config: makeConfig(),
      getLastUserMessage: () => "run tests",
      evaluateToolCall: async () => ({ verdict: "ASK", reason: "confirm command" }),
      onApprovalNeeded: approvalCallback,
    });

    const args = { command: "npm test" };
    const execution = wrapped.execute("call1", args, controller.signal);
    await started;
    controller.abort();
    const result = await execution;
    resolveApproval("allow_always");
    await Promise.resolve();

    expect(result.content[0].text).toContain("aborted");
    expect(calls).toHaveLength(0);
    expect(store.hasToolApproval("test_unresolved_approval_abort")).toBe(false);
    expect(store.isInvocationApproved("test_unresolved_approval_abort", args, { userId: "user1", source: "agent" })).toBe(false);
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
    const wrapped = wrapToolsWithTrustChecks([safe, elevated], store, "user4", {
      config: makeConfig(),
      getLastUserMessage: () => undefined,
      evaluateToolCall: async () => ({ verdict: "ALLOW", reason: "safe" }),
    });
    expect(wrapped).toHaveLength(2);

    const safeResult = await wrapped[0].execute("c1", {});
    expect(safeResult.content[0].text).toBe("ok");

    const elevatedResult = await wrapped[1].execute("c2", {});
    expect(elevatedResult.content[0].text).toContain("Permission required");
  });
});
