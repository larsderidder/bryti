import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { readOnlyTurnEvidence } from "./read-only.js";

function turn(toolName?: string) {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Check status", timestamp: Date.now() });
  if (toolName) {
    manager.appendMessage(fauxAssistantMessage(fauxToolCall(toolName, {}), { stopReason: "toolUse" }));
  }
  manager.appendMessage(fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider unavailable" }));
  return manager.getEntries();
}

describe("read-only failure evidence", () => {
  it("recognizes a failed provider turn that invoked no tools", () => {
    const entries = turn();
    expect(readOnlyTurnEvidence(entries, new Set())).toEqual(entries.map((entry) => entry.id));
  });

  it("recognizes only the loaded application's read implementations", () => {
    expect(readOnlyTurnEvidence(turn("read"), new Set(["read"]))).not.toBeNull();
    expect(readOnlyTurnEvidence(turn("read"), new Set())).toBeNull();
  });

  it.each(["bash", "file_write", "codemode", "outline_document_get", "command_start"])(
    "requires review when %s may have executed",
    (toolName) => {
      expect(readOnlyTurnEvidence(turn(toolName), new Set(["read"]))).toBeNull();
    },
  );

  it("does not discard calls on errored assistant messages", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage(fauxAssistantMessage(fauxToolCall("bash", {}), { stopReason: "error" }));
    expect(readOnlyTurnEvidence(manager.getEntries(), new Set(["read"]))).toBeNull();
  });

  it("checks orphan results as well as assistant calls", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "toolResult", toolCallId: "orphan", toolName: "bash", isError: false,
      content: [{ type: "text", text: "done" }], timestamp: Date.now() });
    expect(readOnlyTurnEvidence(manager.getEntries(), new Set(["read"]))).toBeNull();
  });

  it("does not treat missing canonical history as proof", () => {
    expect(readOnlyTurnEvidence([], new Set(["read"]))).toBeNull();
  });
});
