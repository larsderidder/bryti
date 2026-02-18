import { describe, it, expect } from "vitest";
import { repairToolUseResultPairing } from "./transcript-repair.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// Helpers to build typed messages
function userMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function assistantMsg(toolCallId?: string): AgentMessage {
  const content: unknown[] = [{ type: "text", text: "ok" }];
  if (toolCallId) {
    content.push({ type: "toolCall", id: toolCallId, name: "test_tool", input: {} });
  }
  return { role: "assistant", content, timestamp: Date.now() } as AgentMessage;
}

function toolResultMsg(toolCallId: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "test_tool",
    content: [{ type: "text", text: "result" }],
    isError: false,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

describe("repairToolUseResultPairing", () => {
  it("returns original array unchanged when nothing needs fixing", () => {
    const msgs = [
      userMsg("hi"),
      assistantMsg("call-1"),
      toolResultMsg("call-1"),
      assistantMsg(),
    ];
    const result = repairToolUseResultPairing(msgs);
    expect(result.changed).toBe(false);
    expect(result.messages).toBe(msgs); // same reference
    expect(result.added).toHaveLength(0);
    expect(result.droppedDuplicateCount).toBe(0);
    expect(result.droppedOrphanCount).toBe(0);
  });

  it("inserts synthetic result for a tool call with no result", () => {
    const msgs = [
      userMsg("hi"),
      assistantMsg("call-1"),
      // missing toolResult
      userMsg("follow up"),
    ];
    const result = repairToolUseResultPairing(msgs);
    expect(result.changed).toBe(true);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].toolCallId).toBe("call-1");
    expect(result.added[0].isError).toBe(true);

    // Repaired sequence: assistant -> synthetic result -> user (follow up)
    const roles = result.messages.map((m) => (m as { role: string }).role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "user"]);
  });

  it("drops duplicate tool results", () => {
    const msgs = [
      userMsg("hi"),
      assistantMsg("call-1"),
      toolResultMsg("call-1"),
      toolResultMsg("call-1"), // duplicate
    ];
    const result = repairToolUseResultPairing(msgs);
    expect(result.changed).toBe(true);
    expect(result.droppedDuplicateCount).toBe(1);
    const toolResults = result.messages.filter(
      (m) => (m as { role: string }).role === "toolResult",
    );
    expect(toolResults).toHaveLength(1);
  });

  it("drops orphaned tool results (no matching assistant tool call)", () => {
    const msgs = [
      userMsg("hi"),
      toolResultMsg("orphan-id"), // no preceding assistant toolCall
      assistantMsg(),
    ];
    const result = repairToolUseResultPairing(msgs);
    expect(result.changed).toBe(true);
    expect(result.droppedOrphanCount).toBe(1);
    const toolResults = result.messages.filter(
      (m) => (m as { role: string }).role === "toolResult",
    );
    expect(toolResults).toHaveLength(0);
  });

  it("moves displaced tool result to immediately follow its assistant", () => {
    const msgs = [
      userMsg("hi"),
      assistantMsg("call-1"),
      userMsg("displaced"),        // user message between assistant and its result
      toolResultMsg("call-1"),     // displaced result
    ];
    const result = repairToolUseResultPairing(msgs);
    expect(result.changed).toBe(true);

    // tool result should appear right after the assistant
    const roles = result.messages.map((m) => (m as { role: string }).role);
    const assistantIdx = roles.indexOf("assistant");
    expect(roles[assistantIdx + 1]).toBe("toolResult");
  });

  it("handles empty message list", () => {
    const result = repairToolUseResultPairing([]);
    expect(result.changed).toBe(false);
    expect(result.messages).toHaveLength(0);
  });

  it("handles assistant with multiple tool calls", () => {
    const msgs = [
      userMsg("hi"),
      assistantMsg("call-A"),
      // Manually add second tool call to the same assistant message
    ];

    // Build an assistant message with two tool calls
    const multi: AgentMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "using tools" },
        { type: "toolCall", id: "call-A", name: "tool_a", input: {} },
        { type: "toolCall", id: "call-B", name: "tool_b", input: {} },
      ],
      timestamp: Date.now(),
    } as AgentMessage;

    const msgs2 = [
      userMsg("hi"),
      multi,
      toolResultMsg("call-A"),
      // call-B has no result
    ];

    const result = repairToolUseResultPairing(msgs2);
    expect(result.changed).toBe(true);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].toolCallId).toBe("call-B");

    const toolResults = result.messages.filter(
      (m) => (m as { role: string }).role === "toolResult",
    );
    expect(toolResults).toHaveLength(2);
  });
});
