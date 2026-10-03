import { beforeEach, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createConfiguredSearchTool } from "./search-router.js";

const mocks = vi.hoisted(() => ({ primary: vi.fn(), fallback: vi.fn() }));
vi.mock("../util/parallel-api.js", () => ({ parallelSearch: mocks.primary }));
vi.mock("./web-search.js", () => ({
  createWebSearchTool: () => ({ name: "web_search", parameters: Type.Object({ query: Type.String() }), execute: mocks.fallback }),
  createBraveSearchTool: () => ({ name: "web_search", execute: vi.fn() }),
}));
const config = { enabled: true, provider: "parallel" as const, searxng_url: "https://search.xithing.eu" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fallback.mockResolvedValue({ content: [{ type: "text", text: "Secondary evidence" }], details: { unresponsiveEngines: [] } });
});

it("uses Parallel behind web_search without consulting SearXNG on success", async () => {
  mocks.primary.mockResolvedValue({ results: [{ title: "Guide", url: "https://example.org", excerpts: ["Primary evidence"] }], warnings: [], latencyMs: 1 });
  const result = await createConfiguredSearchTool(config).execute("call", { query: "query" });
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Primary evidence") });
  expect(mocks.fallback).not.toHaveBeenCalled();
});

it.each(["Parallel credential unavailable", "Parallel returned HTTP 429", "Parallel request failed or timed out"])("visibly falls back after %s", async (reason) => {
  mocks.primary.mockRejectedValue(new Error(reason));
  const result = await createConfiguredSearchTool(config).execute("call", { query: "query" });
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining(reason) });
  expect(mocks.fallback).toHaveBeenCalledOnce();
});

it("tries the secondary source on an empty primary result", async () => {
  mocks.primary.mockResolvedValue({ results: [], warnings: [], latencyMs: 1 });
  const result = await createConfiguredSearchTool(config).execute("call", { query: "query" });
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Parallel returned no results") });
});

it("does not start fallback after the caller cancels", async () => {
  const controller = new AbortController();
  mocks.primary.mockImplementationOnce(() => { controller.abort(); throw new Error("cancelled"); });
  await expect(createConfiguredSearchTool(config).execute("call", { query: "query" }, controller.signal)).rejects.toThrow();
  expect(mocks.fallback).not.toHaveBeenCalled();
});

it("preserves secondary failure and reports degraded coverage", async () => {
  mocks.primary.mockRejectedValue(new Error("Primary failed"));
  mocks.fallback.mockResolvedValue({ content: [{ type: "text", text: "Secondary failed" }], details: { unresponsiveEngines: [["google", "timeout"]] }, isError: true });
  const result = await createConfiguredSearchTool(config).execute("call", { query: "query" });
  expect(result.isError).toBe(true);
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("degraded engines") });
});

it("reports an unavailable primary without inventing a configured fallback", async () => {
  mocks.primary.mockRejectedValue(new Error("Primary failed"));
  const result = await createConfiguredSearchTool({ ...config, searxng_url: "" }).execute("call", { query: "query" });
  expect(result.isError).toBe(true);
  expect(mocks.fallback).not.toHaveBeenCalled();
});
