/**
 * Integration tests for processMessage() pipeline.
 *
 * These tests use a pre-built AppState with fully mocked bridges and sessions
 * so no real LLM or Telegram connection is needed. The goal is to verify the
 * pipeline wiring: that the right bridge methods are called, usage is tracked,
 * history is logged, and edge cases (errors, SILENT_REPLY_TOKEN, max-length
 * rejection) are handled correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppState } from "./process-message.js";
import { processMessage } from "./process-message.js";
import { SILENT_REPLY_TOKEN } from "./agent.js";
import { createHistoryManager } from "./history.js";
import { createCoreMemory } from "./memory/core-memory.js";
import { createUsageTracker } from "./usage.js";
import { createTrustStore } from "./trust/index.js";
import type { ChannelBridge, IncomingMessage } from "./channels/types.js";
import type { UserSession } from "./agent.js";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bryti-pm-test-"));
}

function makeConfig(dataDir: string): Config {
  return {
    agent: {
      name: "test",
      system_prompt: "You are a test agent.",
      model: "test-provider/test-model",
      fallback_models: [],
      timezone: "UTC",
    },
    telegram: { token: "", allowed_users: [12345] },
    whatsapp: { enabled: false, allowed_users: [] },
    models: {
      providers: [
        {
          name: "test-provider",
          base_url: "http://localhost:9999",
          api: "openai-completions",
          api_key: "test-key",
          models: [{ id: "test-model" }],
        },
      ],
    },
    tools: {
      web_search: { enabled: false, searxng_url: "" },
      fetch_url: { timeout_ms: 10000 },
      workers: { max_concurrent: 3 },
    },
    integrations: {},
    cron: [],
    trust: { approved_tools: [] },
    data_dir: dataDir,
    active_hours: undefined,
  };
}

/** Minimal mock channel bridge. */
function makeBridge(): ChannelBridge & {
  sent: Array<{ channelId: string; text: string }>;
  typings: string[];
} {
  const sent: Array<{ channelId: string; text: string }> = [];
  const typings: string[] = [];
  return {
    platform: "telegram",
    name: "mock-telegram",
    sent,
    typings,
    async start() {},
    async stop() {},
    onMessage() {},
    async sendMessage(channelId, text) {
      sent.push({ channelId, text });
      return "msg-id";
    },
    async sendTyping(channelId) {
      typings.push(channelId);
    },
    async sendApprovalRequest() {
      return "approve-msg-id";
    },
    async editMessage() {
      return "msg-id";
    },
  } as unknown as ChannelBridge & { sent: Array<{ channelId: string; text: string }>; typings: string[] };
}

/** Build a minimal mock UserSession whose session.prompt() resolves immediately. */
function makeUserSession(
  userId: string,
  responseMessages: Array<{ role: string; content: unknown; provider?: string; model?: string; stopReason?: string; usage?: unknown }> = [],
): UserSession {
  const messages: unknown[] = [...responseMessages];
  return {
    userId,
    sessionDir: "/tmp/test-session",
    lastUserMessageAt: 0,
    extensionErrors: [],
    projectionStore: { close: () => {} } as any,
    modelRegistry: {} as any,
    session: {
      get messages() { return messages; },
      async prompt() {},
      async abort() {},
      async reload() {},
      dispose() {},
      agent: { replaceMessages(_msgs: unknown[]) {} },
      getContextUsage() { return { percent: 10, tokens: 1000, contextWindow: 10000 }; },
      async refreshSystemPrompt() {},
    } as any,
    dispose: vi.fn(),
    onCompactionComplete: undefined,
  } as unknown as UserSession;
}

/** Helper to build an assistant message as the SDK would return it. */
function assistantMsg(
  text: string,
  opts: { stopReason?: string; provider?: string; model?: string; usage?: unknown } = {},
) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: opts.stopReason ?? "end_turn",
    provider: opts.provider ?? "test-provider",
    model: opts.model ?? "test-model",
    usage: opts.usage ?? { input: 10, output: 5 },
  };
}

/** Build a minimal AppState with a pre-seeded session. */
function makeState(
  config: Config,
  userSession: UserSession,
  tmpDir: string,
): AppState {
  const bridge = makeBridge();
  const coreMemory = createCoreMemory(tmpDir);
  const historyManager = createHistoryManager(tmpDir);
  const usageTracker = createUsageTracker(tmpDir);
  const trustStore = createTrustStore(tmpDir, []);

  const state: AppState = {
    config,
    coreMemory,
    historyManager,
    usageTracker,
    sessions: new Map([[userSession.userId, userSession]]),
    bridges: [bridge],
    scheduler: { start() {}, stop() {} } as any,
    enqueue: null,
    trustStore,
    lastUserMessages: new Map(),
    recoveredSessions: new Set(),
    requestRestart: null,
  };

  return state;
}

function incomingMsg(text: string, userId = "12345"): IncomingMessage {
  return {
    text,
    channelId: userId,
    userId,
    platform: "telegram",
    raw: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processMessage pipeline", () => {
  let tmpDir: string;
  let config: Config;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    config = makeConfig(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends the assistant text response to the bridge", async () => {
    const session = makeUserSession("12345", [
      assistantMsg("Hello! How can I help?"),
    ]);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await processMessage(state, incomingMsg("Hi there"));

    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].text).toBe("Hello! How can I help?");
    expect(bridge.sent[0].channelId).toBe("12345");
  });

  it("sends a typing indicator before prompting", async () => {
    const session = makeUserSession("12345", [assistantMsg("Ok")]);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await processMessage(state, incomingMsg("ping"));

    expect(bridge.typings).toContain("12345");
  });

  it("logs user and assistant messages to history", async () => {
    const session = makeUserSession("12345", [assistantMsg("Here is the answer.")]);
    const state = makeState(config, session, tmpDir);

    await processMessage(state, incomingMsg("What is 2+2?"));

    // History files land in <dataDir>/history/<YYYY-MM-DD>.jsonl
    const histDir = path.join(tmpDir, "history");
    const files = fs.existsSync(histDir) ? fs.readdirSync(histDir) : [];
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(histDir, files[0]), "utf-8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    const roles = lines.map((l: any) => l.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });

  it("writes a usage record", async () => {
    const session = makeUserSession("12345", [
      assistantMsg("Done.", { usage: { input: 100, output: 50 } }),
    ]);
    const state = makeState(config, session, tmpDir);

    await processMessage(state, incomingMsg("Do something"));

    const usageDir = path.join(tmpDir, "usage");
    const files = fs.existsSync(usageDir) ? fs.readdirSync(usageDir) : [];
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(usageDir, files[0]), "utf-8");
    const record = JSON.parse(content.trim().split("\n")[0]);
    expect(record.user_id).toBe("12345");
    expect(record.input_tokens).toBe(100);
    expect(record.output_tokens).toBe(50);
  });

  it("suppresses SILENT_REPLY_TOKEN without sending a message", async () => {
    const session = makeUserSession("12345", [assistantMsg(SILENT_REPLY_TOKEN)]);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await processMessage(state, incomingMsg("[System: silent scheduler turn]"));

    expect(bridge.sent).toHaveLength(0);
  });

  it("rejects messages over 10K characters without prompting the model", async () => {
    const longText = "a".repeat(10_001);
    const session = makeUserSession("12345", []);
    const promptSpy = vi.spyOn(session.session, "prompt");
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await processMessage(state, incomingMsg(longText));

    expect(promptSpy).not.toHaveBeenCalled();
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].text).toContain("too long");
  });

  it("sends an error message when the model returns stopReason=error", async () => {
    const session = makeUserSession("12345", [
      assistantMsg("", { stopReason: "error", ...{ errorMessage: "rate limited" } }),
    ]);
    // Patch errorMessage onto the last message directly
    const lastMsg = session.session.messages[session.session.messages.length - 1] as any;
    lastMsg.errorMessage = "rate limited";

    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await processMessage(state, incomingMsg("help"));

    const texts = bridge.sent.map((s) => s.text);
    expect(texts.some((t) => t.includes("went wrong"))).toBe(true);
  });

  it("catches and reports thrown errors gracefully", async () => {
    const session = makeUserSession("12345", []);
    vi.spyOn(session.session, "prompt").mockRejectedValue(new Error("network failure"));

    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await expect(processMessage(state, incomingMsg("hello"))).resolves.not.toThrow();
    expect(bridge.sent.some((s) => s.text.includes("went wrong"))).toBe(true);
  });
});
