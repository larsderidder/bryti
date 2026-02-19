import { describe, it, expect, vi } from "vitest";
import { createArchivalMemoryTools } from "./archival-memory-tool.js";
import type { MemoryStore, ScoredResult } from "../memory/store.js";
import type { ProjectionStore, Projection } from "../projection/store.js";

const createMockStore = (keywordResults: ScoredResult[] = [], vectorResults: ScoredResult[] = []): MemoryStore => ({
  addFact: vi.fn().mockReturnValue("fact-id"),
  removeFact: vi.fn(),
  searchKeyword: vi.fn().mockResolvedValue(keywordResults),
  searchVector: vi.fn().mockResolvedValue(vectorResults),
  close: vi.fn(),
});

const createMockProjectionStore = (triggered: Projection[] = []): ProjectionStore => ({
  add: vi.fn().mockReturnValue("proj-id"),
  getUpcoming: vi.fn().mockReturnValue([]),
  getExactDue: vi.fn().mockReturnValue([]),
  resolve: vi.fn().mockReturnValue(true),
  rearm: vi.fn().mockReturnValue(true),
  checkTriggers: vi.fn().mockReturnValue(triggered),
  autoExpire: vi.fn().mockReturnValue(0),
  linkDependency: vi.fn().mockReturnValue("dep-id"),
  evaluateDependencies: vi.fn().mockReturnValue(0),
  getDependencies: vi.fn().mockReturnValue([]),
  close: vi.fn(),
});

describe("ArchivalMemoryTools", () => {
  it("inserts archival memory", async () => {
    const store = createMockStore();
    const embed = vi.fn().mockResolvedValue(new Array(768).fill(0.1));
    const tools = createArchivalMemoryTools(store, embed);

    const insertTool = tools.find((tool) => tool.name === "archival_memory_insert")!;
    const result = await insertTool.execute("call1", { content: "Meeting notes" });

    expect(result.details).toEqual({ success: true });
    expect(store.addFact).toHaveBeenCalled();
  });

  it("calls checkTriggers after inserting a fact when projection store is provided", async () => {
    const store = createMockStore();
    const embed = vi.fn().mockResolvedValue(new Array(768).fill(0.1));
    const projStore = createMockProjectionStore();
    const tools = createArchivalMemoryTools(store, embed, projStore);

    const insertTool = tools.find((tool) => tool.name === "archival_memory_insert")!;
    await insertTool.execute("call1", { content: "dentist confirmed for Thursday" });

    expect(projStore.checkTriggers).toHaveBeenCalledWith("dentist confirmed for Thursday");
  });

  it("returns triggered projection summaries in the result when triggers fire", async () => {
    const store = createMockStore();
    const embed = vi.fn().mockResolvedValue(new Array(768).fill(0.1));
    const fakeProjection: Projection = {
      id: "proj-1",
      summary: "Book time off after dentist",
      raw_when: null,
      resolved_when: "2026-02-19 11:00",
      resolution: "exact",
      recurrence: null,
      trigger_on_fact: null,
      context: null,
      linked_ids: [],
      status: "pending",
      created_at: new Date().toISOString(),
      resolved_at: null,
    };
    const projStore = createMockProjectionStore([fakeProjection]);
    const tools = createArchivalMemoryTools(store, embed, projStore);

    const insertTool = tools.find((tool) => tool.name === "archival_memory_insert")!;
    const result = await insertTool.execute("call1", { content: "dentist confirmed" });

    expect((result.details as any).triggered).toEqual(["Book time off after dentist"]);
  });

  it("returns plain success when no triggers fire", async () => {
    const store = createMockStore();
    const embed = vi.fn().mockResolvedValue(new Array(768).fill(0.1));
    const projStore = createMockProjectionStore([]);
    const tools = createArchivalMemoryTools(store, embed, projStore);

    const insertTool = tools.find((tool) => tool.name === "archival_memory_insert")!;
    const result = await insertTool.execute("call1", { content: "random fact" });

    expect(result.details).toEqual({ success: true });
  });

  it("works without a projection store (backward compat)", async () => {
    const store = createMockStore();
    const embed = vi.fn().mockResolvedValue(new Array(768).fill(0.1));
    const tools = createArchivalMemoryTools(store, embed);

    const insertTool = tools.find((tool) => tool.name === "archival_memory_insert")!;
    const result = await insertTool.execute("call1", { content: "something" });

    expect(result.details).toEqual({ success: true });
  });

  it("searches archival memory", async () => {
    const store = createMockStore([
      {
        id: "1",
        content: "Meeting with Alice on Friday",
        source: "archival",
        timestamp: Date.now(),
        score: 1,
      },
    ]);
    const embed = vi.fn().mockResolvedValue(new Array(768).fill(0.2));
    const tools = createArchivalMemoryTools(store, embed);

    const searchTool = tools.find((tool) => tool.name === "archival_memory_search")!;
    const result = await searchTool.execute("call1", { query: "Alice" });

    expect(result.details).toHaveProperty("results");
    expect((result.details as any).results[0]).toHaveProperty("content");
  });
});
