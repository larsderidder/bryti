import { describe, expect, it, vi } from "vitest";
import { createSessionDiagnostics } from "./session-diagnostics.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDiagnosticWriter } from "./session-diagnostics.js";

describe("session diagnostics", () => {
  it("correlates nested calls and distinguishes run end from settlement without recording payloads", () => {
    const rows: Record<string, unknown>[] = [];
    const diagnostics = createSessionDiagnostics({ userId: "owner", sessionId: "session", sessionKey: "owner/topic",
      write: (row) => rows.push(row) });
    diagnostics.event({ type: "agent_start" });
    diagnostics.event({ type: "tool_execution_start", toolName: "codemode", toolCallId: "parent", args: { secret: "private-fixture" } });
    diagnostics.event({ type: "tool_execution_start", toolName: "read", toolCallId: "parent/1", parentToolCallId: "parent", args: { path: "private-fixture" } });
    diagnostics.event({ type: "tool_execution_end", toolName: "read", toolCallId: "parent/1", parentToolCallId: "parent", isError: true, result: { secret: "private-fixture" } });
    diagnostics.event({ type: "tool_execution_end", toolName: "codemode", toolCallId: "parent", isError: false, result: {} });
    diagnostics.event({ type: "agent_end", messages: [], willRetry: true });
    expect(rows.some((row) => row.type === "agent_settled")).toBe(false);
    diagnostics.event({ type: "agent_settled" });
    const child = rows.find((row) => row.type === "tool_execution_end" && row.tool_call_id === "parent/1");
    expect(child).toMatchObject({ parent_tool_call_id: "parent", outcome: "error", duration_ms: expect.any(Number) });
    expect(new Set(rows.map((row) => row.run_id)).size).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("private-fixture");
  });

  it("captures provider metadata only when enabled, bounds events, and never copies raw data", () => {
    const rows: Record<string, unknown>[] = [];
    const diagnostics = createSessionDiagnostics({ userId: "owner", sessionId: "session", sessionKey: "owner",
      captureProvider: true, write: (row) => rows.push(row) });
    diagnostics.event({ type: "agent_start" });
    for (let index = 0; index < 1000; index++) {
      diagnostics.providerEvent({ provider: "fixture", api: "openai-completions", model: "fixture",
        data: { type: "private-fixture", delta: "private-fixture", headers: { authorization: "private-fixture" } } });
    }
    diagnostics.event({ type: "agent_settled" });
    expect(JSON.stringify(rows)).not.toContain("private-fixture");
    expect(rows.filter((row) => row.type === "provider_stream_summary")).toHaveLength(1);
    expect(rows.find((row) => row.type === "provider_stream_summary")).toMatchObject({ sampled_events: 200, dropped_events: 800 });
    const off = createSessionDiagnostics({ userId: "owner", sessionId: "session", sessionKey: "owner", write: (row) => rows.push(row) });
    const before = rows.length;
    off.providerEvent({ provider: "fixture", api: "fixture", model: "fixture", data: "private-fixture" });
    expect(rows).toHaveLength(before);
  });

  it("records uncertain unfinished calls on disposal and tolerates a broken writer", () => {
    const write = vi.fn();
    const diagnostics = createSessionDiagnostics({ userId: "owner", sessionId: "session", sessionKey: "owner", write });
    diagnostics.event({ type: "agent_start" });
    diagnostics.event({ type: "tool_execution_start", toolName: "write", toolCallId: "unfinished", args: {} });
    diagnostics.close();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ tool_call_id: "unfinished", outcome: "unknown" }));
    write.mockImplementation(() => { throw new Error("Full filesystem"); });
    expect(() => diagnostics.event({ type: "agent_start" })).not.toThrow();
  });

  it("records only status, model labels, and timing at provider boundaries", () => {
    const rows: Record<string, unknown>[] = [];
    const diagnostics = createSessionDiagnostics({ userId: "owner", sessionId: "fixture", sessionKey: "owner",
      captureProvider: true, write: (row) => rows.push(row) });
    diagnostics.event({ type: "agent_start" });
    diagnostics.request({ provider: "fixture", api: "fixture", id: "fixture" });
    diagnostics.response(429);
    diagnostics.providerEvent({ provider: "fixture", api: "fixture", model: "fixture", data: { type: "error", message: "private-fixture" } });
    diagnostics.event({ type: "agent_settled" });
    expect(rows).toContainEqual(expect.objectContaining({ type: "provider_response", status: 429, headers_latency_ms: expect.any(Number) }));
    expect(rows).toContainEqual(expect.objectContaining({ type: "provider_stream_summary", provider: "fixture", model: "fixture" }));
    expect(JSON.stringify(rows)).not.toContain("private-fixture");
  });

  it("retains a terminal truncation notice when lifecycle events exhaust the run budget", () => {
    const rows: Record<string, unknown>[] = [];
    const diagnostics = createSessionDiagnostics({ userId: "owner", sessionId: "fixture", sessionKey: "owner", write: (row) => rows.push(row) });
    diagnostics.event({ type: "agent_start" });
    for (let index = 0; index < 3000; index++) {
      diagnostics.event({ type: "turn_start" });
    }
    diagnostics.event({ type: "agent_settled" });
    expect(rows.length).toBeLessThanOrEqual(2000);
    expect(rows.at(-1)).toMatchObject({ type: "diagnostics_closed", reason: "settled", dropped_records: expect.any(Number) });
  });

  it("rotates private bounded files and refuses links without changing their targets", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-diagnostics-"));
    const file = path.join(directory, "logs", "diagnostics.jsonl");
    try {
      const write = createDiagnosticWriter(directory, 4096);
      for (let index = 0; index < 100; index++) {
        write({ type: "fixture", value: "fixture".repeat(100) });
      }
      for (const target of [file, file + ".1"]) {
        expect(fs.statSync(target).size).toBeLessThanOrEqual(4096);
        expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      }
      const target = path.join(directory, "private-fixture");
      fs.writeFileSync(target, "private-fixture");
      fs.unlinkSync(file);
      fs.symlinkSync(target, file);
      expect(() => write({ type: "fixture" })).not.toThrow();
      expect(fs.readFileSync(target, "utf8")).toBe("private-fixture");
      fs.unlinkSync(file);
      fs.linkSync(target, file);
      write({ type: "fixture" });
      expect(fs.readFileSync(target, "utf8")).toBe("private-fixture");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
