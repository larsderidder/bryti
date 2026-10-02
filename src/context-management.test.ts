import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { abbreviateContextResults, readContextResult } from "./context-management.js";

const options = { enabled: true, min_chars: 1000, keep_chars: 400, keep_recent_turns: 2 };

function result(manager: SessionManager, name = "read", isError = false, content = "a".repeat(2000)) {
  manager.appendMessage(fauxAssistantMessage(fauxToolCall(name, {}, { id: "call-fixture" }), { stopReason: "toolUse" }));
  return manager.appendMessage({ role: "toolResult", toolName: name, toolCallId: "call-fixture",
    content: [{ type: "text", text: content }], isError, timestamp: 1 });
}

function laterTurns(manager: SessionManager) {
  manager.appendMessage({ role: "user", content: "Later request", timestamp: 2 });
  manager.appendMessage(fauxAssistantMessage("Later answer"));
  manager.appendMessage({ role: "user", content: "Current request", timestamp: 3 });
}

describe("append-only context cleanup", () => {
  it("abbreviates older successful reads while preserving originals, metadata, and usage", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "Original request", timestamp: 0 });
    const id = result(manager);
    laterTurns(manager);
    const original = structuredClone(manager.getEntries());
    expect(abbreviateContextResults(manager, options, new Set(["read"]))).toBe(1);
    expect(manager.getEntries().slice(0, original.length)).toEqual(original);
    const projected = manager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === id)!;
    expect(projected.messages[0]).toMatchObject({ role: "toolResult", toolCallId: "call-fixture", isError: false });
    expect(JSON.stringify(projected.messages[0])).toContain(id);
    expect(JSON.stringify(projected.messages[0])).not.toContain("a".repeat(1000));
    expect(readContextResult(manager, id, 0)).toMatchObject({ text: "a".repeat(2000), total_chars: 2000 });
    expect(abbreviateContextResults(manager, options, new Set(["read"]))).toBe(0);
    const leaf = manager.getLeafId()!;
    manager.branch(id);
    expect(JSON.stringify(manager.buildSessionContext())).toContain("a".repeat(2000));
    manager.branch(leaf);
    expect(JSON.stringify(manager.buildSessionContext())).not.toContain("a".repeat(1000));
  });

  it("retains edits and original recovery across native compaction", () => {
    const manager = SessionManager.inMemory();
    const id = result(manager);
    const first = manager.getEntries()[0].id;
    laterTurns(manager);
    abbreviateContextResults(manager, options, new Set(["read"]));
    manager.appendCompaction("Summary", first, 100);
    expect(JSON.stringify(manager.buildSessionContext())).not.toContain("a".repeat(1000));
    expect(readContextResult(manager, id, 0).text).toBe("a".repeat(2000));
  });

  it.each([["write", false], ["codemode", false], ["read", true], ["untrusted_extension", false]])(
    "never abbreviates errors, writes, orchestration, or unapproved tools: %s/%s", (name, isError) => {
      const manager = SessionManager.inMemory();
      manager.appendMessage({ role: "user", content: "Original", timestamp: 0 });
      result(manager, name, isError);
      laterTurns(manager);
      expect(abbreviateContextResults(manager, options, new Set(["read"]))).toBe(0);
    },
  );

  it("retains recent results and refuses results from another branch", () => {
    const manager = SessionManager.inMemory();
    const root = manager.appendMessage({ role: "user", content: "Original", timestamp: 0 });
    const id = result(manager);
    expect(abbreviateContextResults(manager, options, new Set(["read"]))).toBe(0);
    manager.branch(root);
    expect(() => readContextResult(manager, id, 0)).toThrow("not available");
    expect(() => readContextResult(manager, "../../other", 0)).toThrow("not available");
  });

  it("does not alter existing edits, images, or results after failed assistant calls", () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "Original", timestamp: 0 });
    const edited = result(manager);
    manager.appendContextEdit(edited, { content: "Operator replacement" });
    manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "image", isError: false,
      content: [{ type: "image", data: "fixture", mimeType: "image/png" }], timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", {}, { id: "failed" }), { stopReason: "error" }));
    manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "failed", isError: false,
      content: [{ type: "text", text: "b".repeat(2000) }], timestamp: 1 });
    laterTurns(manager);
    expect(abbreviateContextResults(manager, options, new Set(["read"]))).toBe(0);
  });

  it("bounds each recovery page and rejects invalid offsets", () => {
    const manager = SessionManager.inMemory();
    const id = result(manager, "read", false, "x".repeat(10000));
    expect(readContextResult(manager, id, 4000)).toMatchObject({ text: "x".repeat(4000), next_offset: 8000 });
    for (const offset of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => readContextResult(manager, id, offset)).toThrow("Invalid offset");
    }
    expect(abbreviateContextResults(manager, { ...options, enabled: false }, new Set(["read"]))).toBe(0);
  });

  it("never enlarges a result when retained excerpts are close to the cleanup threshold", () => {
    for (let keep = 700; keep < 1000; keep++) {
      const manager = SessionManager.inMemory();
      const id = result(manager, "read", false, "a".repeat(1001));
      laterTurns(manager);
      abbreviateContextResults(manager, { ...options, keep_chars: keep }, new Set(["read"]));
      const entry = manager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === id)!;
      const projected = entry.messages[0];
      if (projected.role === "toolResult") {
        expect(projected.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").length).toBeLessThanOrEqual(1001);
      }
    }
  });
});
