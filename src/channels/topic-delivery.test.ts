import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.js";
import { getSessionKey } from "../threads.js";
import { createTopicDeliveryTracker, importTopicDeliveries } from "./topic-delivery.js";

const userId = "12345";
const chatId = "-1003987750931";
const threadId = "telegram-topic-1003987750931-32";
const text = "Two Pokémon links: Planet Fantasy and Monsteriada. Neither is verified.";

function deliveredResult(messageId = 349) {
  return { content: [{ type: "text", text: JSON.stringify({
    ok: true, chat_id: chatId, message_thread_id: 32, message_id: messageId,
  }) }] };
}

function makeSession(dataDir: string, existing = true) {
  const manager = SessionManager.create(dataDir, path.join(dataDir, "test-session"));
  if (existing) {
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Earlier domain discussion" }],
      api: "openai-responses", provider: "test", model: "test", stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(),
    });
  }
  const session = {
    sessionManager: manager,
    get sessionFile() { return manager.getSessionFile(); },
    isStreaming: false,
    sendCustomMessage: vi.fn(async (message) => {
      manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    }),
  };
  return { session: session as unknown as AgentSession, manager, send: session.sendCustomMessage };
}

describe("cross-topic delivery context", () => {
  let dataDir: string;
  let config: Pick<Config, "data_dir" | "telegram">;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-topic-delivery-"));
    config = { data_dir: dataDir, telegram: {
      token: "", mode: "group", allowed_users: [12345], allowed_groups: [Number(chatId)],
    } };
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function send(result = deliveredResult(), isError = false, source = userId, callId = "send-1") {
    const track = createTopicDeliveryTracker(config, userId, source);
    track({ type: "tool_execution_start", toolName: "telegram_forum_topic_send", toolCallId: callId,
      args: { chat_id: chatId, message_thread_id: 32, text } });
    track({ type: "tool_execution_end", toolName: "telegram_forum_topic_send", toolCallId: callId,
      result, isError });
  }

  it("persists confirmed sends for the destination and imports them without triggering a reply", async () => {
    send();
    const { session, manager, send: inject } = makeSession(dataDir);
    const acknowledge = await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject).toHaveBeenCalledOnce();
    expect(inject).toHaveBeenCalledWith(expect.objectContaining({
      customType: "bryti-topic-delivery",
      content: expect.stringContaining(text),
      details: expect.objectContaining({ channelId: chatId, channelThreadId: "32", messageId: "349" }),
    }), { triggerTurn: false });
    expect(inject.mock.calls[0][0].content).toContain("already sent");
    expect(inject.mock.calls[0][0].content).toContain("not a new user instruction");
    acknowledge();
    const reloaded = SessionManager.open(manager.getSessionFile()!);
    expect(reloaded.buildSessionContext().messages.some((m) => m.role === "custom")).toBe(true);
    await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject).toHaveBeenCalledOnce();
  });

  it("accepts the deployed untrusted-output envelope", async () => {
    const result = deliveredResult();
    result.content[0].text = "Untrusted extension output.\n<<<BRYTI_UNTRUSTED_EXTENSION_OUTPUT_BEGIN>>>\n"
      + result.content[0].text + "\n<<<BRYTI_UNTRUSTED_EXTENSION_OUTPUT_END>>>";
    send(result);
    const { session, send: inject } = makeSession(dataDir);
    await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject).toHaveBeenCalledOnce();
  });

  it.each([
    { ok: false },
    { ok: true, chat_id: chatId, message_thread_id: 32 },
    { ok: true, chat_id: chatId, message_thread_id: 42, message_id: 349 },
    { ok: true, chat_id: "-999", message_thread_id: 32, message_id: 349 },
    { ok: true, chat_id: chatId, message_thread_id: 32, message_id: -1 },
    null,
  ])("does not import unconfirmed or mismatched receipts: %j", async (receipt) => {
    send({ content: [{ type: "text", text: JSON.stringify(receipt) }] });
    const { session, send: inject } = makeSession(dataDir);
    await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject).not.toHaveBeenCalled();
  });

  it("does not treat SDK errors as successful sends", async () => {
    send(deliveredResult(), true);
    const { session, send: inject } = makeSession(dataDir);
    await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject).not.toHaveBeenCalled();
  });

  it("isolates users and topics and does not duplicate same-session sends", async () => {
    send(deliveredResult(), false, getSessionKey(userId, threadId));
    const { session, send: inject } = makeSession(dataDir);
    await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject).not.toHaveBeenCalled();
    send();
    await importTopicDeliveries(dataDir, "67890", threadId, session);
    await importTopicDeliveries(dataDir, userId, "telegram-topic-1003987750931-42", session);
    expect(inject).not.toHaveBeenCalled();
    await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject).toHaveBeenCalledOnce();
  });

  it("keeps unacknowledged context across restarts without importing it twice", async () => {
    send();
    send();
    const first = makeSession(dataDir);
    await importTopicDeliveries(dataDir, userId, threadId, first.session);
    expect(first.send).toHaveBeenCalledOnce();
    const manager = SessionManager.open(first.manager.getSessionFile()!);
    const reloaded = { ...first.session, sessionManager: manager };
    const acknowledge = await importTopicDeliveries(dataDir, userId, threadId, reloaded);
    expect(first.send).toHaveBeenCalledOnce();
    acknowledge();
    const fresh = makeSession(dataDir);
    await importTopicDeliveries(dataDir, userId, threadId, fresh.session);
    expect(fresh.send).not.toHaveBeenCalled();
  });

  it("keeps the inbox when a new SDK session has not flushed its transcript", async () => {
    send();
    const first = makeSession(dataDir, false);
    const acknowledge = await importTopicDeliveries(dataDir, userId, threadId, first.session);
    acknowledge();
    expect(fs.existsSync(first.manager.getSessionFile()!)).toBe(false);
    const restarted = makeSession(dataDir, false);
    await importTopicDeliveries(dataDir, userId, threadId, restarted.session);
    expect(restarted.send).toHaveBeenCalledOnce();
  });

  it("deduplicates against entries that have since been compacted", async () => {
    send();
    const { session, manager, send: inject } = makeSession(dataDir);
    await importTopicDeliveries(dataDir, userId, threadId, session);
    const kept = manager.appendMessage({ role: "user", content: "Continue", timestamp: Date.now() });
    manager.appendCompaction("The two Pokémon links were posted here.", kept, 1000);
    expect(manager.buildSessionContext().messages.some((message) => message.role === "custom")).toBe(false);
    await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject).toHaveBeenCalledOnce();
  });

  it("retains pending messages when destination insertion fails", async () => {
    send();
    const failed = makeSession(dataDir);
    failed.send.mockRejectedValueOnce(new Error("Transcript unavailable"));
    await expect(importTopicDeliveries(dataDir, userId, threadId, failed.session)).rejects.toThrow("Transcript unavailable");
    const retried = makeSession(dataDir);
    await importTopicDeliveries(dataDir, userId, threadId, retried.session);
    expect(retried.send).toHaveBeenCalledOnce();
  });

  it.each(["dm", "other-user", "other-group"])("ignores sends outside configured topic routing: %s", async (mode) => {
    if (mode === "dm") {
      config.telegram.mode = "dm";
    } else if (mode === "other-user") {
      config.telegram.allowed_users = [67890];
    } else {
      config.telegram.allowed_groups = [-999];
    }
    send();
    const { session, send: inject } = makeSession(dataDir);
    await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject).not.toHaveBeenCalled();
  });

  it("imports messages in Telegram order and leaves concurrent arrivals pending", async () => {
    send(deliveredResult(350), false, userId, "send-2");
    send();
    const { session, send: inject } = makeSession(dataDir);
    const acknowledge = await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject.mock.calls.map(([message]) => message.details.messageId)).toEqual(["349", "350"]);
    send(deliveredResult(351), false, userId, "send-3");
    acknowledge();
    await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject.mock.calls.map(([message]) => message.details.messageId)).toEqual(["349", "350", "351"]);
  });

  it("refuses to mutate an actively running destination session", async () => {
    send();
    const { session, send: inject } = makeSession(dataDir);
    Object.defineProperty(session, "isStreaming", { value: true });
    await expect(importTopicDeliveries(dataDir, userId, threadId, session)).rejects.toThrow("active session turn");
    expect(inject).not.toHaveBeenCalled();
  });

  it("imports the initial message of a successfully created topic", async () => {
    const track = createTopicDeliveryTracker(config, userId, userId);
    track({ type: "tool_execution_start", toolName: "telegram_forum_topic_create", toolCallId: "create-1",
      args: { chat_id: chatId, title: "TCG", initial_message: text } });
    track({ type: "tool_execution_end", toolName: "telegram_forum_topic_create", toolCallId: "create-1",
      result: { content: [{ type: "text", text: JSON.stringify({ ok: true, chat_id: chatId, message_thread_id: 32 }) }] },
      isError: false });
    const { session, send: inject } = makeSession(dataDir);
    await importTopicDeliveries(dataDir, userId, threadId, session);
    expect(inject).toHaveBeenCalledOnce();
    expect(inject.mock.calls[0][0].content).toContain(text);
  });
});
