import { describe, it, expect } from "vitest";
import { parseVerdict, buildGuardrailPrompt } from "./guardrail.js";

describe("parseVerdict", () => {
  it("parses ALLOW with reason", () => {
    const result = parseVerdict("ALLOW: listing directory contents as requested");
    expect(result.verdict).toBe("ALLOW");
    expect(result.reason).toBe("listing directory contents as requested");
  });

  it("parses ASK with reason", () => {
    const result = parseVerdict("ASK: deleting files outside the workspace directory");
    expect(result.verdict).toBe("ASK");
    expect(result.reason).toBe("deleting files outside the workspace directory");
  });

  it("parses BLOCK with reason", () => {
    const result = parseVerdict("BLOCK: piping untrusted URL content to shell execution");
    expect(result.verdict).toBe("BLOCK");
    expect(result.reason).toBe("piping untrusted URL content to shell execution");
  });

  it("handles lowercase verdict", () => {
    const result = parseVerdict("allow: simple read operation");
    expect(result.verdict).toBe("ALLOW");
  });

  it("handles verdict without colon", () => {
    const result = parseVerdict("ALLOW listing files");
    expect(result.verdict).toBe("ALLOW");
  });

  it("defaults to ASK on unparseable response", () => {
    const result = parseVerdict("I think this is probably fine");
    expect(result.verdict).toBe("ASK");
    expect(result.reason).toContain("unparseable");
  });

  it("handles multiline response (takes first line with verdict)", () => {
    const result = parseVerdict("ALLOW: safe operation\nThis is additional explanation");
    expect(result.verdict).toBe("ALLOW");
    expect(result.reason).toBe("safe operation");
  });

  it("finds verdict on a later line (models sometimes prefix with explanation)", () => {
    const result = parseVerdict(
      "Let me evaluate this tool call.\nThe user asked for a restart.\nALLOW: user explicitly requested restart",
    );
    expect(result.verdict).toBe("ALLOW");
    expect(result.reason).toBe("user explicitly requested restart");
  });

  it("falls back to word search when no VERDICT: pattern found", () => {
    const result = parseVerdict("This action should be ALLOWED because it is safe");
    expect(result.verdict).toBe("ALLOW");
  });

  it("word search prefers BLOCK over ALLOW", () => {
    const result = parseVerdict("I would not allow this, it should be blocked");
    expect(result.verdict).toBe("BLOCK");
  });

  it("handles empty response", () => {
    const result = parseVerdict("");
    expect(result.verdict).toBe("ASK");
  });
});

describe("buildGuardrailPrompt", () => {
  it("includes tool name and args", () => {
    const prompt = buildGuardrailPrompt({
      toolName: "shell_exec",
      args: '{"command": "ls -la"}',
    });
    expect(prompt).toContain("shell_exec");
    expect(prompt).toContain("ls -la");
  });

  it("includes user message when provided", () => {
    const prompt = buildGuardrailPrompt({
      toolName: "shell_exec",
      args: '{"command": "rm -rf /tmp/old"}',
      userMessage: "clean up the temp files",
    });
    expect(prompt).toContain("clean up the temp files");
  });

  it("includes tool description when provided", () => {
    const prompt = buildGuardrailPrompt({
      toolName: "http_request",
      args: '{"url": "https://api.weather.com"}',
      toolDescription: "Makes HTTP requests to external services",
    });
    expect(prompt).toContain("Makes HTTP requests");
  });
});
