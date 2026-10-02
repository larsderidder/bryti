import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseVerdict, buildGuardrailPrompt, evaluateToolCall } from "./guardrail.js";
import type { Config } from "../config.js";
import type { ModelInfra } from "../model-infra.js";

const { complete, resolve } = vi.hoisted(() => ({ complete: vi.fn(), resolve: vi.fn() }));
vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: complete }));
vi.mock("../model-infra.js", () => ({
  createModelInfra: vi.fn(), resolveModel: resolve,
  resolveFirstModel: (candidates: string[]) => resolve(candidates[0]),
}));

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


describe("guardrail model fallback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resolve.mockImplementation((name: string) => ({ provider: name.split("/")[0], id: name.split("/")[1] }));
    complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "ALLOW: routine read" }] });
  });

  const config = { agent: { model: "primary/model", fallback_models: ["fallback/model"] } } as Config;
  const input = { toolName: "read_test", args: "{}" };

  function infrastructure(auth: ReturnType<typeof vi.fn>): ModelInfra {
    return { modelRegistry: { getApiKeyAndHeaders: auth } } as unknown as ModelInfra;
  }

  it("tries the fallback when the primary model cannot authenticate", async () => {
    const auth = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "invalid_grant" })
      .mockResolvedValueOnce({ ok: true, apiKey: "test" });
    expect(await evaluateToolCall(config, input, infrastructure(auth))).toEqual({ verdict: "ALLOW", reason: "routine read" });
    expect(complete.mock.calls[0][0].provider).toBe("fallback");
  });

  it("tries the fallback when authentication throws", async () => {
    const auth = vi.fn().mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce({ ok: true, apiKey: "test" });
    expect((await evaluateToolCall(config, input, infrastructure(auth))).verdict).toBe("ALLOW");
  });

  it("tries the fallback after a provider error without weakening a BLOCK verdict", async () => {
    const auth = vi.fn().mockResolvedValue({ ok: true, apiKey: "test" });
    complete.mockResolvedValueOnce({ stopReason: "error", errorMessage: "unavailable", content: [] })
      .mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "BLOCK: unsafe" }] });
    expect(await evaluateToolCall(config, input, infrastructure(auth))).toEqual({ verdict: "BLOCK", reason: "unsafe" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not seek a more permissive answer after ASK", async () => {
    const auth = vi.fn().mockResolvedValue({ ok: true, apiKey: "test" });
    complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "ASK: confirm destination" }] });
    expect((await evaluateToolCall(config, input, infrastructure(auth))).verdict).toBe("ASK");
    expect(complete).toHaveBeenCalledOnce();
  });

  it("fails closed when all candidates cannot authenticate, without exposing provider errors", async () => {
    const auth = vi.fn().mockResolvedValue({ ok: false, error: "private provider response" });
    const result = await evaluateToolCall(config, input, infrastructure(auth));
    expect(result.verdict).toBe("ASK");
    expect(result.reason).not.toContain("private provider response");
    expect(auth).toHaveBeenCalledTimes(2);
    expect(complete).not.toHaveBeenCalled();
  });


  it("stops fallback attempts when the supervising call is cancelled", async () => {
    const controller = new AbortController();
    const auth = vi.fn().mockResolvedValue({ ok: true, apiKey: "test" });
    complete.mockImplementation(async (_model, _context, options) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      controller.abort();
      throw new Error("request aborted");
    });
    expect((await evaluateToolCall(config, input, infrastructure(auth), controller.signal)).verdict).toBe("ASK");
    expect(complete).toHaveBeenCalledOnce();
    expect(auth).toHaveBeenCalledOnce();
  });
});
