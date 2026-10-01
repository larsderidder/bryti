import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createTranscriptRepairExtension } from "./session-repair.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function assistant(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "lost", name: "write", arguments: {} }],
    api: "anthropic-messages", provider: "anthropic", model: "test",
    stopReason: "toolUse", timestamp: 1,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function getRepair(factory: ExtensionFactory) {
  let repair: ((event: { messages: AgentMessage[] }) => { messages: AgentMessage[] }) | undefined;
  factory({ on(name: string, handler: typeof repair) {
    if (name === "context") {
      repair = handler;
    }
  } } as unknown as ExtensionAPI);
  expect(repair).toBeDefined();
  return repair!;
}

describe("canonical transcript repair", () => {
  it("repairs every provider projection without mutating canonical messages or billing", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "do it", timestamp: 0 });
    manager.appendMessage(assistant() as Parameters<SessionManager["appendMessage"]>[0]);
    const repair = getRepair(createTranscriptRepairExtension());
    const before = manager.getEntries();
    const messages = manager.buildSessionContext().messages;
    const repaired = repair({ messages }).messages;
    expect(repaired.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(repaired.at(-1)).toMatchObject({ toolCallId: "lost", isError: true });
    expect(manager.getEntries()).toEqual(before);
    expect(messages).toHaveLength(2);
    expect(repair({ messages: repaired }).messages).toEqual(repaired);
  });

  it("repairs reloaded history and retains custom messages", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-repair-"));
    directories.push(directory);
    const manager = SessionManager.create(directory, directory);
    manager.appendMessage({ role: "user", content: "do it", timestamp: 0 });
    manager.appendMessage(assistant() as Parameters<SessionManager["appendMessage"]>[0]);
    manager.appendCustomMessageEntry("delivery", "confirmed delivery", false);
    const reloaded = SessionManager.open(manager.getSessionFile()!, directory);
    const repaired = getRepair(createTranscriptRepairExtension())({
      messages: reloaded.buildSessionContext().messages,
    }).messages;
    expect(repaired.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "custom"]);
    expect(repaired.at(-1)).toMatchObject({ customType: "delivery" });
  });
});
