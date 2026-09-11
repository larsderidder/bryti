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
import { tryCompact } from "./compaction/proactive.js";
import { createWorkStore } from "./work/store.js";
import { deliveryNotSent } from "./channels/delivery.js";
import { createProjectionStore } from "./projection/store.js";
import { scheduledWorkId } from "./scheduler.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTopicDeliveryTracker } from "./channels/topic-delivery.js";
import { getSessionKey } from "./threads.js";

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
      fetch_url: { enabled: true, timeout_ms: 10000, backend: "readability", require_https: true },
      workers: { max_concurrent: 3 },
    },
    integrations: {},
    cron: [],
    voice: {
      enabled: false,
      transcribe_command: [],
      synthesize_command: [],
      reply_with_voice: true,
      keep_temp_files: false,
      command_timeout_ms: 1000,
      synthesized_audio_extension: ".ogg",
      max_tts_chars: 2500,
    },
    trust: { approved_tools: [] },
    data_dir: dataDir,
    active_hours: undefined,
  };
}

/** Minimal mock channel bridge. */
function makeBridge(): ChannelBridge & {
  sent: Array<{ channelId: string; text: string }>;
  voices: Array<{ channelId: string; audioPath: string }>;
  typings: string[];
} {
  const sent: Array<{ channelId: string; text: string }> = [];
  const voices: Array<{ channelId: string; audioPath: string }> = [];
  const typings: string[] = [];
  return {
    platform: "telegram",
    name: "mock-telegram",
    sent,
    voices,
    typings,
    async start() {},
    async stop() {},
    onMessage() {},
    async sendMessage(channelId, text) {
      sent.push({ channelId, text });
      return "msg-id";
    },
    async sendVoice(channelId, audioPath) {
      voices.push({ channelId, audioPath });
      return "voice-msg-id";
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
  } as unknown as ChannelBridge & {
    sent: Array<{ channelId: string; text: string }>;
    voices: Array<{ channelId: string; audioPath: string }>;
    typings: string[];
  };
}

type TestUserSession = UserSession & {
  emitEvent(event: unknown): void;
};

/** Build a minimal mock UserSession whose session.prompt() resolves immediately. */
function makeUserSession(
  userId: string,
  responseMessages: Array<{ role: string; content: unknown; provider?: string; model?: string; stopReason?: string; usage?: unknown }> = [],
): TestUserSession {
  const messages: unknown[] = [...responseMessages];
  const listeners = new Set<(event: unknown) => void>();
  const model = { provider: "test-provider", id: "test-model", api: "openai-completions" };
  return {
    userId,
    sessionDir: "/tmp/test-session",
    lastUserMessageAt: 0,
    extensionErrors: [],
    projectionStore: { close: () => {} } as any,
    modelRegistry: { find: () => model } as any,
    session: {
      model,
      setModel: vi.fn().mockResolvedValue(undefined),
      get messages() { return messages; },
      async prompt() {},
      async abort() {},
      async reload() {},
      dispose() {},
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      agent: { replaceMessages(_msgs: unknown[]) {} },
      getContextUsage() { return { percent: 10, tokens: 1000, contextWindow: 10000 }; },
      async refreshSystemPrompt() {},
    } as any,
    dispose: vi.fn(),
    onCompactionComplete: undefined,
    emitEvent(event: unknown) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  } as unknown as TestUserSession;
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
    voiceService: null,
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
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes cross-topic sends before answering a follow-up, without sending them again", async () => {
    const userId = "12345";
    const chatId = "-1003987750931";
    const threadId = "telegram-topic-1003987750931-32";
    const deliveryText = "Two Pokémon links: Planet Fantasy and Monsteriada.";
    fs.mkdirSync(path.join(tmpDir, "pending"));
    config.telegram = { token: "", mode: "group", allowed_users: [12345], allowed_groups: [Number(chatId)] };
    const track = createTopicDeliveryTracker(config, userId, userId);
    track({ type: "tool_execution_start", toolName: "telegram_forum_topic_send", toolCallId: "send-1",
      args: { chat_id: chatId, message_thread_id: 32, text: deliveryText } });
    track({ type: "tool_execution_end", toolName: "telegram_forum_topic_send", toolCallId: "send-1", isError: false,
      result: { content: [{ type: "text", text: JSON.stringify({
        ok: true, chat_id: chatId, message_thread_id: 32, message_id: 349,
      }) }] } });
    const userSession = makeUserSession(userId, [assistantMsg("Earlier domain discussion")]);
    const manager = SessionManager.inMemory(tmpDir);
    Object.assign(userSession.session, {
      sessionManager: manager,
      sendCustomMessage: vi.fn(async (message) => {
        manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        userSession.session.messages.push({ ...message, role: "custom", timestamp: Date.now() });
      }),
    });
    const prompt = vi.spyOn(userSession.session, "prompt").mockImplementation(async () => {
      expect(userSession.session.messages.at(-1)).toMatchObject({
        role: "custom", content: expect.stringContaining(deliveryText),
      });
      userSession.session.messages.push(assistantMsg("Those shops came from your watcher.") as any);
    });
    const state = makeState(config, userSession, tmpDir);
    state.sessions = new Map([[getSessionKey(userId, threadId), userSession]]);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;
    await processMessage(state, { ...incomingMsg("Why are you checking exactly those two?"),
      channelId: chatId, threadId, channelThreadId: "32" });
    expect(prompt).toHaveBeenCalledOnce();
    expect(userSession.session.sendCustomMessage).toHaveBeenCalledOnce();
    expect(bridge.sent).toEqual([{ channelId: chatId, text: "Those shops came from your watcher." }]);
    expect(state.lastUserMessages.get(getSessionKey(userId, threadId))).toBe("Why are you checking exactly those two?");
  });

  it.each(["cancelled", "done", "rescheduled", "cancel-during-load", "pending"] as const)("checks the current projection before prompting: %s", async (status) => {
    const session = makeUserSession("12345", [assistantMsg("Executed")]);
    vi.spyOn(session.session, "prompt");
    const state = makeState(config, session, tmpDir);
    const store = createProjectionStore("12345", tmpDir);
    state.workStore = createWorkStore(tmpDir);
    const id = store.add({ summary: "Scheduled action", resolution: "exact", resolved_when: "2099-01-01 10:00" });
    const workId = scheduledWorkId("12345", store.getById(id)!);
    const msg = { ...incomingMsg("Execute scheduled action"), workId, workIds: [workId], raw: { type: "projection_exact_check" } };
    state.workStore.accept(msg);
    state.workStore.claim([workId]);
    store.markDeliveryWork(id, workId);
    if (status === "rescheduled") {
      store.update(id, { resolved_when: "2099-01-02 10:00" });
    } else if (status === "cancel-during-load") {
      state.bridges[0].sendTyping = async () => { store.resolve(id, "cancelled"); };
    } else if (status !== "pending") {
      store.resolve(id, status);
    }
    try {
      await processMessage(state, msg);
      if (status === "pending") {
        expect(session.session.prompt).toHaveBeenCalledOnce();
      } else {
        expect(session.session.prompt).not.toHaveBeenCalled();
      }
      expect(state.workStore.get(workId)?.execution).toBe("failed");
    } finally {
      state.workStore.close();
      store.close();
    }
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

  it("hides thinking blocks by default", async () => {
    const session = makeUserSession("12345", [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Visible answer" },
      ],
      stopReason: "end_turn",
      provider: "test-provider",
      model: "test-model",
      usage: { input: 10, output: 5 },
    }]);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await processMessage(state, incomingMsg("Hi"));

    expect(bridge.sent[0].text).toBe("Visible answer");
    expect(bridge.sent[0].text).not.toContain("private reasoning");
  });

  it("can expose thinking blocks when configured", async () => {
    config.response = { show_thinking: true };
    const session = makeUserSession("12345", [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Visible answer" },
      ],
      stopReason: "end_turn",
      provider: "test-provider",
      model: "test-model",
      usage: { input: 10, output: 5 },
    }]);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await processMessage(state, incomingMsg("Hi"));

    expect(bridge.sent[0].text).toContain("> Thinking:");
    expect(bridge.sent[0].text).toContain("> private reasoning");
    expect(bridge.sent[0].text).toContain("Visible answer");
  });

  it("strips XML-style thinking from string content by default", async () => {
    const session = makeUserSession("12345", [{
      role: "assistant",
      content: "<thinking>private reasoning</thinking>Visible answer",
      stopReason: "end_turn",
      provider: "test-provider",
      model: "test-model",
      usage: { input: 10, output: 5 },
    }]);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await processMessage(state, incomingMsg("Hi"));

    expect(bridge.sent[0].text).toBe("Visible answer");
  });

  it("suppresses SILENT_REPLY_TOKEN without sending a message", async () => {
    const session = makeUserSession("12345", [assistantMsg(SILENT_REPLY_TOKEN)]);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await processMessage(state, incomingMsg("[System: silent scheduler turn]"));

    expect(bridge.sent).toHaveLength(0);
  });

  it("transcribes incoming audio before normal text processing", async () => {
    config.voice!.enabled = true;
    config.voice!.transcribe_command = ["stub", "{input}", "{output}"];
    const audioPath = path.join(tmpDir, "incoming.ogg");
    fs.writeFileSync(audioPath, "voice bytes");

    const session = makeUserSession("12345", [assistantMsg("Processed transcript")]);
    const state = makeState(config, session, tmpDir);
    state.voiceService = {
      transcribe: vi.fn(async () => "hello from audio"),
      synthesize: vi.fn(async () => path.join(tmpDir, "unused.ogg")),
    };

    await processMessage(state, {
      ...incomingMsg("The user sent a voice message."),
      audio: [{ path: audioPath, mimeType: "audio/ogg" }],
      replyMode: "voice",
    });

    const histDir = path.join(tmpDir, "history");
    const files = fs.readdirSync(histDir);
    const content = fs.readFileSync(path.join(histDir, files[0]), "utf-8");
    expect(content).toContain("[Voice message transcript]");
    expect(content).toContain("hello from audio");
    expect(fs.existsSync(audioPath)).toBe(false);
  });

  it("creates a TTS reply when replyMode is voice", async () => {
    config.voice!.enabled = true;
    config.voice!.reply_with_voice = true;
    config.voice!.transcribe_command = ["stub", "{input}", "{output}"];
    config.voice!.synthesize_command = ["stub", "{input}", "{output}"];

    const outputPath = path.join(tmpDir, "reply.ogg");
    fs.writeFileSync(outputPath, "voice reply");

    const session = makeUserSession("12345", [assistantMsg("Voice reply text")]);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;
    state.voiceService = {
      transcribe: vi.fn(async () => "unused"),
      synthesize: vi.fn(async () => outputPath),
    };

    await processMessage(state, {
      ...incomingMsg("hello"),
      replyMode: "voice",
    });

    expect(bridge.voices).toHaveLength(1);
    expect(bridge.voices[0].audioPath).toBe(outputPath);
    expect(bridge.sent).toHaveLength(0);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("falls back to text when voice reply cannot be sent", async () => {
    config.voice!.enabled = true;
    config.voice!.reply_with_voice = true;
    config.voice!.synthesize_command = ["stub", "{input}", "{output}"];

    const outputPath = path.join(tmpDir, "reply-fail.ogg");
    fs.writeFileSync(outputPath, "voice reply");

    const session = makeUserSession("12345", [assistantMsg("Fallback text")]);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;
    bridge.sendVoice = vi.fn(async () => {
      throw deliveryNotSent("Voice rejected before upload", { retryable: false });
    });
    state.voiceService = {
      transcribe: vi.fn(async () => "unused"),
      synthesize: vi.fn(async () => outputPath),
    };

    await processMessage(state, {
      ...incomingMsg("hello"),
      replyMode: "voice",
    });

    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].text).toBe("Fallback text");
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it("cleans incoming audio temp files when voice is disabled", async () => {
    config.voice!.enabled = false;

    const inputPath = path.join(tmpDir, "incoming-disabled.ogg");
    fs.writeFileSync(inputPath, "voice bytes");

    const session = makeUserSession("12345", []);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await processMessage(state, {
      ...incomingMsg("The user sent a voice message."),
      audio: [{ path: inputPath, mimeType: "audio/ogg" }],
      replyMode: "voice",
    });

    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].text).toContain("Voice messages are not enabled");
    expect(fs.existsSync(inputPath)).toBe(false);
  });

  it("cleans incoming audio temp files when voice service is unavailable", async () => {
    config.voice!.enabled = true;

    const inputPath = path.join(tmpDir, "incoming-unavailable.ogg");
    fs.writeFileSync(inputPath, "voice bytes");

    const session = makeUserSession("12345", []);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;
    state.voiceService = null;

    await processMessage(state, {
      ...incomingMsg("The user sent a voice message."),
      audio: [{ path: inputPath, mimeType: "audio/ogg" }],
      replyMode: "voice",
    });

    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0].text).toContain("Voice support is enabled but unavailable");
    expect(fs.existsSync(inputPath)).toBe(false);
  });

  it("keeps temp files when keep_temp_files is true", async () => {
    config.voice!.enabled = true;
    config.voice!.keep_temp_files = true;
    config.voice!.transcribe_command = ["stub", "{input}", "{output}"];
    config.voice!.synthesize_command = ["stub", "{input}", "{output}"];

    const inputPath = path.join(tmpDir, "incoming-keep.ogg");
    const outputPath = path.join(tmpDir, "reply-keep.ogg");
    fs.writeFileSync(inputPath, "voice bytes");
    fs.writeFileSync(outputPath, "voice reply");

    const session = makeUserSession("12345", [assistantMsg("Keep files")]);
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;
    state.voiceService = {
      transcribe: vi.fn(async () => "kept transcript"),
      synthesize: vi.fn(async () => outputPath),
    };

    await processMessage(state, {
      ...incomingMsg("The user sent a voice message."),
      audio: [{ path: inputPath, mimeType: "audio/ogg" }],
      replyMode: "voice",
    });

    expect(bridge.voices).toHaveLength(1);
    expect(fs.existsSync(inputPath)).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("logs cleanup warnings without exposing full temp file paths", async () => {
    config.voice!.enabled = true;
    config.voice!.transcribe_command = ["stub", "{input}", "{output}"];

    const nestedDir = path.join(tmpDir, "nested", "voice");
    fs.mkdirSync(nestedDir, { recursive: true });
    const inputPath = path.join(nestedDir, "incoming-secret.ogg");
    fs.writeFileSync(inputPath, "voice bytes");

    const session = makeUserSession("12345", [assistantMsg("Processed transcript")]);
    const state = makeState(config, session, tmpDir);
    state.voiceService = {
      transcribe: vi.fn(async () => "hello from audio"),
      synthesize: vi.fn(async () => path.join(tmpDir, "unused.ogg")),
    };

    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("permission denied");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await processMessage(state, {
      ...incomingMsg("The user sent a voice message."),
      audio: [{ path: inputPath, mimeType: "audio/ogg" }],
      replyMode: "voice",
    });

    expect(warnSpy).toHaveBeenCalled();
    const [message, detail] = warnSpy.mock.calls[0] ?? [];
    expect(String(message)).toContain("incoming-secret.ogg");
    expect(String(message)).not.toContain(nestedDir);
    expect(String(detail)).toContain("permission denied");

    rmSpy.mockRestore();
    warnSpy.mockRestore();
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

  it("reserves the session during prompt preparation, before streaming starts", async () => {
    vi.useFakeTimers();
    const userSession = makeUserSession("12345", Array.from({ length: 6 }, () => assistantMsg("old")));
    const compact = vi.fn().mockResolvedValue(undefined);
    userSession.session.compact = compact;
    let finishReload!: () => void;
    vi.spyOn(userSession.session, "reload").mockImplementation(() => new Promise<void>((resolve) => {
      finishReload = resolve;
    }));
    const state = makeState(config, userSession, tmpDir);
    const processing = processMessage(state, incomingMsg("hello"));
    await vi.advanceTimersByTimeAsync(0);

    try {
      await tryCompact(userSession, "nightly");
      expect(compact).not.toHaveBeenCalled();
    } finally {
      finishReload();
      await processing;
    }
    await tryCompact(userSession, "nightly");
    expect(compact).toHaveBeenCalledOnce();
  });

  it("waits for proactive compaction before reloading or repairing the session", async () => {
    vi.useFakeTimers();
    const userSession = makeUserSession("12345", Array.from({ length: 6 }, () => assistantMsg("old")));
    let finishCompact!: () => void;
    userSession.session.compact = vi.fn(() => new Promise((resolve) => {
      finishCompact = () => resolve({} as Awaited<ReturnType<typeof userSession.session.compact>>);
    }));
    const reload = vi.spyOn(userSession.session, "reload");
    const repair = vi.spyOn(userSession.session.agent, "replaceMessages");
    const compacting = tryCompact(userSession, "nightly");
    const state = makeState(config, userSession, tmpDir);
    const processing = processMessage(state, incomingMsg("hello"));
    await vi.advanceTimersByTimeAsync(0);

    try {
      expect(reload).not.toHaveBeenCalled();
      expect(repair).not.toHaveBeenCalled();
    } finally {
      finishCompact();
      await compacting;
      await processing;
    }
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not time out an active prompt based on total runtime", async () => {
    vi.useFakeTimers();
    const session = makeUserSession("12345", []);
    let finishPrompt!: () => void;
    vi.spyOn(session.session, "prompt").mockImplementation(() => new Promise<void>((resolve) => {
      finishPrompt = resolve;
    }));
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    const processing = processMessage(state, incomingMsg("long task"));
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    session.emitEvent({ type: "tool_execution_start", toolName: "bash" });
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    session.emitEvent({ type: "tool_execution_end", toolName: "bash" });
    (session.session.messages as unknown[]).push(assistantMsg("Done"));
    finishPrompt();
    await processing;

    expect(bridge.sent.some((s) => s.text.includes("took too long"))).toBe(false);
    expect(state.sessions.has("12345")).toBe(true);
  });

  it("times out inactive prompts and evicts the session", async () => {
    vi.useFakeTimers();
    const session = makeUserSession("12345", []);
    vi.spyOn(session.session, "prompt").mockImplementation(() => new Promise(() => {}));
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    const processing = processMessage(state, incomingMsg("hello"));
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    await processing;

    expect(bridge.sent.some((s) => s.text.includes("model stopped producing activity"))).toBe(true);
    expect(state.sessions.has("12345")).toBe(false);
    expect(session.dispose).toHaveBeenCalled();
  });

  it("names the timed-out tool without leaking its arguments", async () => {
    vi.useFakeTimers();
    const session = makeUserSession("12345", []);
    vi.spyOn(session.session, "prompt").mockImplementation(() => new Promise(() => {}));
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;
    const processing = processMessage(state, incomingMsg("run a build"));
    await vi.advanceTimersByTimeAsync(0);
    session.emitEvent({ type: "tool_execution_start", toolCallId: "build", toolName: "bash", args: { timeout: 10, command: "private-command-arguments" } });
    await vi.advanceTimersByTimeAsync(15_000);
    await processing;
    expect(bridge.sent.some((s) => s.text.includes("bash tool exceeded its execution deadline"))).toBe(true);
    expect(bridge.sent.some((s) => s.text.includes("private-command-arguments"))).toBe(false);
    expect(state.sessions.has("12345")).toBe(false);
  });

  it("catches and reports thrown errors gracefully", async () => {
    const session = makeUserSession("12345", []);
    vi.spyOn(session.session, "prompt").mockRejectedValue(new Error("network failure"));

    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await expect(processMessage(state, incomingMsg("hello"))).resolves.not.toThrow();
    expect(bridge.sent.some((s) => s.text.includes("went wrong"))).toBe(true);
  });

  it("cleans up the inactivity watchdog when a prompt fails before timeout", async () => {
    vi.useFakeTimers();
    const session = makeUserSession("12345", []);
    vi.spyOn(session.session, "prompt").mockRejectedValue(new Error("network failure"));
    const abortSpy = vi.spyOn(session.session, "abort");
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0] as ReturnType<typeof makeBridge>;

    await processMessage(state, incomingMsg("hello"));
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    session.emitEvent({ type: "tool_execution_start", toolName: "bash" });
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

    expect(bridge.sent.some((s) => s.text.includes("went wrong"))).toBe(true);
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("also bounds the follow-up prompt when the model initially produces no reply", async () => {
    vi.useFakeTimers();
    const session = makeUserSession("12345", []);
    let release!: () => void;
    vi.spyOn(session.session, "prompt").mockResolvedValueOnce(undefined).mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const state = makeState(config, session, tmpDir);
    const abort = vi.spyOn(session.session, "abort");
    const processing = processMessage(state, incomingMsg("hello"));
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    try {
      expect(abort).toHaveBeenCalled();
      expect(state.sessions.has("12345")).toBe(false);
    } finally {
      release();
      await processing;
    }
  });

  it("does not label an aborted model turn as completed execution", async () => {
    const session = makeUserSession("12345", []);
    vi.spyOn(session.session, "prompt").mockImplementation(async () => {
      (session.session.messages as unknown[]).push({ ...assistantMsg("Partial answer"), stopReason: "aborted" });
    });
    const state = makeState(config, session, tmpDir);
    const workStore = createWorkStore(tmpDir);
    state.workStore = workStore;
    const { record } = workStore.accept(incomingMsg("hello"));
    workStore.claim([record.id]);
    try {
      await processMessage(state, record.message);
      expect(workStore.get(record.id)?.execution).toBe("interrupted");
      expect((state.bridges[0] as ReturnType<typeof makeBridge>).sent).toEqual([]);
    } finally {
      workStore.close();
    }
  });

  it("delivers recovery notices directly without asking the model to resume work", async () => {
    const session = makeUserSession("12345", []);
    const prompt = vi.spyOn(session.session, "prompt");
    const state = makeState(config, session, tmpDir);
    const workStore = createWorkStore(tmpDir);
    state.workStore = workStore;
    const { record } = workStore.accept({ ...incomingMsg("Work was interrupted and was not repeated."), raw: { type: "recovery_notice" } });
    workStore.claim([record.id]);
    try {
      await processMessage(state, record.message);
      expect(prompt).not.toHaveBeenCalled();
      expect(workStore.get(record.id)).toMatchObject({ execution: "completed", delivery: "delivered" });
    } finally {
      workStore.close();
    }
  });

  it("records failed model execution even though the user receives an error message", async () => {
    const session = makeUserSession("12345", []);
    vi.spyOn(session.session, "prompt").mockRejectedValue(new Error("provider failed"));
    const state = makeState(config, session, tmpDir);
    const workStore = createWorkStore(tmpDir);
    state.workStore = workStore;
    const { record } = workStore.accept(incomingMsg("hello"));
    workStore.claim([record.id]);
    try {
      await processMessage(state, record.message);
      expect(workStore.get(record.id)?.execution).toBe("failed");
    } finally {
      workStore.close();
    }
  });

  it("keeps successful execution distinct from an uncertain response delivery", async () => {
    const session = makeUserSession("12345", []);
    vi.spyOn(session.session, "prompt").mockImplementation(async () => {
      (session.session.messages as unknown[]).push(assistantMsg("Done"));
    });
    const state = makeState(config, session, tmpDir);
    const bridge = state.bridges[0];
    const send = vi.spyOn(bridge, "sendMessage").mockRejectedValue(new Error("connection closed after dispatch"));
    const workStore = createWorkStore(tmpDir);
    state.workStore = workStore;
    const { record } = workStore.accept(incomingMsg("hello"));
    workStore.claim([record.id]);
    try {
      await processMessage(state, record.message);
      expect(workStore.get(record.id)).toMatchObject({ execution: "completed", delivery: "unknown" });
      expect(send).toHaveBeenCalledOnce();
    } finally {
      workStore.close();
    }
  });
});
