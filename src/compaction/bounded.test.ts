import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { boundSummary, buildSummaryInput, compactHistory } from "./bounded.js";

function event(reason: SessionBeforeCompactEvent["reason"] = "threshold"): SessionBeforeCompactEvent {
  const manager = SessionManager.inMemory("/tmp");
  const first = manager.appendMessage({ role: "user", content: "Do not publish without approval", timestamp: 1 });
  return {
    type: "session_before_compact", reason, willRetry: false, signal: new AbortController().signal,
    branchEntries: manager.getBranch(),
    preparation: {
      firstKeptEntryId: first, tokensBefore: 250_000, previousSummary: "Approval remains required.",
      messagesToSummarize: [{ role: "user", content: "Earlier investigation", timestamp: 1 }],
      turnPrefixMessages: [], isSplitTurn: false,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("bounded compaction", () => {
  it("bounds inherited file metadata and the entire persisted summary", () => {
    const paths = Array.from({ length: 5000 }, (_, index) => `/private/files/old-${index}.json`).join("\n");
    const summary = boundSummary(`Approval remains required.\n${"history ".repeat(10000)}\n<read-files>\n${paths}\n</read-files>`);
    expect(summary.length).toBeLessThanOrEqual(16000);
    expect(summary).toContain("Approval remains required.");
    expect(summary).toContain("omitted");
    expect(summary).not.toContain("old-4999.json");
  });

  it("bounds the complete summary input and retains the newest request with omission markers", () => {
    const source = event();
    source.preparation.previousSummary = "previous ".repeat(100000);
    source.preparation.messagesToSummarize = Array.from({ length: 1000 }, () => ({
      role: "user" as const, content: "old ".repeat(5000), timestamp: 1,
    }));
    source.preparation.messagesToSummarize.push({ role: "user", content: "Latest request: inspection only", timestamp: 2 });
    const before = JSON.stringify(source.preparation);
    const input = buildSummaryInput(source.preparation, 160000);
    expect(input.length).toBeLessThanOrEqual(160000);
    expect(input).toContain("Latest request: inspection only");
    expect(input).toContain("omitted");
    expect(JSON.stringify(source.preparation)).toBe(before);
  });

  it("reserves input for older user restrictions as well as the newest split-turn prefix", () => {
    const source = event();
    source.preparation.messagesToSummarize = [
      { role: "user", content: "Never publish this investigation", timestamp: 1 },
      ...Array.from({ length: 1000 }, () => ({ role: "user" as const, content: "background ".repeat(5000), timestamp: 2 })),
    ];
    source.preparation.turnPrefixMessages = [{ role: "user", content: "Current split-turn request: inspect only", timestamp: 3 }];
    const input = buildSummaryInput(source.preparation);
    expect(input).toContain("Never publish this investigation");
    expect(input).toContain("Current split-turn request: inspect only");
    expect(input.length).toBeLessThanOrEqual(160000);
  });

  it("returns a bounded native compaction without changing the retained boundary or source entries", async () => {
    const source = event();
    const before = JSON.stringify(source.branchEntries);
    const result = await compactHistory(source, async () => ({ text: "Approval remains required. " + "summary ".repeat(4000) }));
    expect(result.compaction?.summary.length).toBeLessThanOrEqual(16000);
    expect(result.compaction?.firstKeptEntryId).toBe(source.preparation.firstKeptEntryId);
    expect(JSON.stringify(source.branchEntries)).toBe(before);
  });

  it("commits an explicit no-summary boundary after an automatic summary timeout, never inventing success", async () => {
    vi.useFakeTimers();
    const source = event();
    const pending = compactHistory(source, async () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(120000);
    const result = await pending;
    expect(result.compaction?.summary).toContain("without a new summary");
    expect(result.compaction?.summary).toContain("Approval remains required.");
    expect(result.compaction?.details).toMatchObject({ bryti: { degraded: true, reason: "timeout" } });
    expect(result.compaction?.firstKeptEntryId).toBe(source.preparation.firstKeptEntryId);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not turn explicit cancellation into a fallback compaction", async () => {
    const source = event();
    const controller = new AbortController();
    source.signal = controller.signal;
    const pending = compactHistory(source, async () => new Promise(() => {}));
    controller.abort();
    await expect(pending).resolves.toEqual({ cancel: true });
  });

  it("keeps manual history intact on timeout and provider failures", async () => {
    vi.useFakeTimers();
    const pending = compactHistory(event("manual"), async () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(120000);
    await expect(pending).resolves.toEqual({ cancel: true });
    await expect(compactHistory(event("manual"), async () => { throw new Error("auth unavailable"); })).resolves.toEqual({ cancel: true });
  });

  it("persists degraded forward progress after an automatic provider failure", async () => {
    const result = await compactHistory(event(), async () => { throw new Error("auth unavailable"); });
    expect(result.compaction?.summary).toContain("without a new summary");
    expect(result.compaction?.details).toMatchObject({ bryti: { degraded: true, reason: "summary_failed" } });
  });

  it("extends the summary idle deadline on real progress but retains a hard ceiling", async () => {
    vi.useFakeTimers();
    let progress = () => {};
    const pending = compactHistory(event(), async (_input, _signal, onProgress) => {
      progress = onProgress;
      return new Promise(() => {});
    });
    for (let tick = 0; tick < 9; tick++) {
      await vi.advanceTimersByTimeAsync(60000);
      progress();
    }
    await vi.advanceTimersByTimeAsync(60000);
    expect((await pending).compaction?.details).toMatchObject({ bryti: { reason: "timeout" } });
    expect(vi.getTimerCount()).toBe(0);
  });
});
