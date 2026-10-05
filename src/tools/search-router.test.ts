import { beforeEach, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createConfiguredSearchTool } from "./search-router.js";

const mocks = vi.hoisted(() => ({ primary: vi.fn(), secondary: vi.fn() }));
vi.mock("../util/parallel-api.js", () => ({ parallelSearch: mocks.primary }));
vi.mock("./web-search.js", () => ({
  createWebSearchTool: () => ({ name: "web_search", parameters: Type.Object({ query: Type.String() }), execute: mocks.secondary }),
  createBraveSearchTool: () => ({ name: "web_search", execute: vi.fn() }),
}));
const config = { enabled: true, provider: "parallel" as const, searxng_url: "https://search.xithing.eu" };
const primary = { results: [{ title: "Guide", url: "https://example.org/guide", excerpts: ["Primary evidence"] }], warnings: [], latencyMs: 1 };
const secondary = { content: [], details: { results: [{ title: "Second guide", url: "https://second.org/guide", snippet: "Secondary evidence" }], unresponsiveEngines: [] } };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.primary.mockResolvedValue(primary);
  mocks.secondary.mockResolvedValue(secondary);
});

it("searches both sources even when Parallel succeeds, with a larger candidate pool", async () => {
  const result = await createConfiguredSearchTool(config).execute("call", { query: "guide", count: 2 });
  expect(mocks.primary.mock.calls[0][0].count).toBeGreaterThan(2);
  expect(mocks.secondary.mock.calls[0][1].count).toBeGreaterThan(2);
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Secondary evidence") });
  expect(result.details).toMatchObject({ total: 2, incomplete: false });
});

it("starts SearXNG without waiting for Parallel", async () => {
  let finish!: (value: typeof primary) => void;
  mocks.primary.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const pending = createConfiguredSearchTool(config).execute("call", { query: "guide" });
  expect(mocks.secondary).toHaveBeenCalledOnce();
  finish(primary);
  await pending;
});

it.each(["Parallel credential unavailable", "Parallel returned HTTP 429", "Parallel request failed or timed out"])("preserves the secondary results and reports %s", async (reason) => {
  mocks.primary.mockRejectedValue(new Error(reason));
  const result = await createConfiguredSearchTool(config).execute("call", { query: "guide" });
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining(reason) });
  expect(result.details).toMatchObject({ total: 1, incomplete: true });
  expect(result.isError).toBe(false);
});

it("preserves successful Parallel results when SearXNG fails", async () => {
  mocks.secondary.mockResolvedValue({ content: [], details: { error: "Secondary unavailable" }, isError: true });
  const result = await createConfiguredSearchTool(config).execute("call", { query: "guide" });
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Primary evidence") });
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Secondary unavailable") });
  expect(result.isError).toBe(false);
});

it("does not turn an empty successful search into a provider failure", async () => {
  mocks.primary.mockResolvedValue({ ...primary, results: [] });
  mocks.secondary.mockResolvedValue({ content: [], details: { results: [], unresponsiveEngines: [] } });
  const result = await createConfiguredSearchTool(config).execute("call", { query: "guide" });
  expect(result.details).toMatchObject({ total: 0, incomplete: false });
  expect(result.isError).toBe(false);
});

it("cancels both already-running sources", async () => {
  const controller = new AbortController();
  mocks.primary.mockImplementation((_input, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }));
  mocks.secondary.mockImplementation((_id, _input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  }));
  const pending = createConfiguredSearchTool(config).execute("call", { query: "guide" }, controller.signal);
  expect(mocks.primary).toHaveBeenCalledOnce();
  expect(mocks.secondary).toHaveBeenCalledOnce();
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(mocks.primary.mock.calls[0][1].signal.aborted).toBe(true);
  expect(mocks.secondary.mock.calls[0][2].aborted).toBe(true);
});

it("does not start either source after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(createConfiguredSearchTool(config).execute("call", { query: "guide" }, controller.signal)).rejects.toThrow();
  expect(mocks.primary).not.toHaveBeenCalled();
  expect(mocks.secondary).not.toHaveBeenCalled();
});

it("reports secondary engine degradation without discarding usable results", async () => {
  mocks.secondary.mockResolvedValue({ ...secondary, details: { ...secondary.details, unresponsiveEngines: [["google", "timeout"]] } });
  const result = await createConfiguredSearchTool(config).execute("call", { query: "guide" });
  expect(result.details).toMatchObject({ total: 2, incomplete: true });
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("degraded engines") });
});

it("reports an unavailable search when both sources fail", async () => {
  mocks.primary.mockRejectedValue(new Error("Primary failed"));
  mocks.secondary.mockResolvedValue({ content: [], details: { error: "Secondary failed" }, isError: true });
  const result = await createConfiguredSearchTool(config).execute("call", { query: "guide" });
  expect(result.isError).toBe(true);
});

it("does not invent a configured SearXNG endpoint", async () => {
  const result = await createConfiguredSearchTool({ ...config, searxng_url: "" }).execute("call", { query: "guide" });
  expect(result.details).toMatchObject({ total: 1, incomplete: true });
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("No SearXNG source configured") });
  expect(mocks.secondary).not.toHaveBeenCalled();
});
