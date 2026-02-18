import { describe, it, expect } from "vitest";
import { limitHistoryTurns } from "./history.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

function userMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

describe("limitHistoryTurns", () => {
  it("returns original array when limit is undefined", () => {
    const msgs = [userMsg("a"), assistantMsg("b")];
    expect(limitHistoryTurns(msgs, undefined)).toBe(msgs);
  });

  it("returns original array when limit is zero", () => {
    const msgs = [userMsg("a"), assistantMsg("b")];
    expect(limitHistoryTurns(msgs, 0)).toBe(msgs);
  });

  it("returns original array when fewer turns than limit", () => {
    const msgs = [userMsg("1"), assistantMsg("r1"), userMsg("2"), assistantMsg("r2")];
    const result = limitHistoryTurns(msgs, 5);
    expect(result).toBe(msgs);
  });

  it("returns all messages when exactly at limit", () => {
    const msgs = [userMsg("1"), assistantMsg("r1"), userMsg("2"), assistantMsg("r2")];
    const result = limitHistoryTurns(msgs, 2);
    expect(result).toBe(msgs);
  });

  it("trims to last N user turns", () => {
    const msgs = [
      userMsg("1"), assistantMsg("r1"),
      userMsg("2"), assistantMsg("r2"),
      userMsg("3"), assistantMsg("r3"),
      userMsg("4"), assistantMsg("r4"),
    ];
    const result = limitHistoryTurns(msgs, 2);
    // Should keep the last 2 user turns (3 and 4 and their responses)
    expect(result).toHaveLength(4);
    const texts = result
      .filter((m) => m.role === "user")
      .map((m) => (m.content as Array<{ text: string }>)[0].text);
    expect(texts).toEqual(["3", "4"]);
  });

  it("returns original array for empty input", () => {
    const result = limitHistoryTurns([], 5);
    expect(result).toHaveLength(0);
  });

  it("keeps associated assistant messages and tool results with each user turn", () => {
    const msgs = [
      userMsg("old"),
      assistantMsg("old-response"),
      userMsg("recent"),
      assistantMsg("recent-response"),
    ];
    const result = limitHistoryTurns(msgs, 1);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect((result[0].content as Array<{ text: string }>)[0].text).toBe("recent");
  });
});
