import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { searchConversations } from "./conversation-search.js";

describe("searchConversations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/bryti-conversation-search-");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const writeJsonl = (fileName: string, lines: string[]) => {
    fs.writeFileSync(path.join(tempDir, fileName), lines.join("\n"), "utf-8");
  };

  it("finds matching messages and returns metadata", () => {
    writeJsonl("2026-02-15.jsonl", [
      JSON.stringify({ role: "user", content: "Book dentist appointment", timestamp: "2026-02-15T10:00:00Z" }),
    ]);

    const results = searchConversations(tempDir, "dentist", 10);

    expect(results).toHaveLength(1);
    expect(results[0].role).toBe("user");
    expect(results[0].timestamp).toBe("2026-02-15T10:00:00Z");
    expect(results[0].date).toBe("2026-02-15");
  });

  it("is case insensitive", () => {
    writeJsonl("2026-02-15.jsonl", [
      JSON.stringify({ role: "assistant", content: "Dentist reminder", timestamp: "2026-02-15T12:00:00Z" }),
    ]);

    const results = searchConversations(tempDir, "dentist", 10);

    expect(results).toHaveLength(1);
  });

  it("searches across multiple files and returns most recent first", () => {
    writeJsonl("2026-02-15.jsonl", [
      JSON.stringify({ role: "user", content: "Dentist", timestamp: "2026-02-15T10:00:00Z" }),
    ]);
    writeJsonl("2026-02-16.jsonl", [
      JSON.stringify({ role: "assistant", content: "Dentist follow-up", timestamp: "2026-02-16T09:00:00Z" }),
    ]);

    const results = searchConversations(tempDir, "dentist", 10);

    expect(results).toHaveLength(2);
    expect(results[0].date).toBe("2026-02-16");
    expect(results[1].date).toBe("2026-02-15");
  });

  it("respects limit", () => {
    writeJsonl("2026-02-16.jsonl", [
      JSON.stringify({ role: "assistant", content: "Dentist follow-up", timestamp: "2026-02-16T09:00:00Z" }),
      JSON.stringify({ role: "user", content: "Dentist again", timestamp: "2026-02-16T09:30:00Z" }),
    ]);

    const results = searchConversations(tempDir, "dentist", 1);

    expect(results).toHaveLength(1);
  });

  it("returns empty for missing directory", () => {
    const results = searchConversations(path.join(tempDir, "missing"), "dentist", 10);
    expect(results).toEqual([]);
  });

  it("returns empty for empty query", () => {
    const results = searchConversations(tempDir, "", 10);
    expect(results).toEqual([]);
  });

  it("skips malformed JSON lines", () => {
    writeJsonl("2026-02-16.jsonl", [
      "{not-json}",
      JSON.stringify({ role: "user", content: "Dentist", timestamp: "2026-02-16T09:00:00Z" }),
    ]);

    const results = searchConversations(tempDir, "dentist", 10);

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Dentist");
  });

  it("returns empty for empty history directory", () => {
    const results = searchConversations(tempDir, "dentist", 10);
    expect(results).toEqual([]);
  });
});
