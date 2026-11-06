import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { compactHistory } from "./bounded.js";
import { contextLoss, pendingContextWarning } from "./context-state.js";

describe("persistent context-loss disclosure", () => {
  it("discloses degraded context once and carries its identity through a later successful summary", async () => {
    const manager = SessionManager.inMemory("/tmp");
    const user = manager.appendMessage({ role: "user", content: "Inspection only", timestamp: 1 });
    manager.appendCompaction("Older context omitted", user, 200000,
      { bryti: { degraded: true, contextLossId: "loss-boundary" } }, true);
    expect(pendingContextWarning(manager)?.id).toBe("loss-boundary");
    manager.appendCustomEntry("bryti-context-disclosure", { id: "loss-boundary" });
    expect(pendingContextWarning(manager)).toBeUndefined();
    const result = await compactHistory({
      type: "session_before_compact", reason: "threshold", willRetry: false,
      branchEntries: manager.getBranch(), signal: new AbortController().signal,
      preparation: { firstKeptEntryId: user, tokensBefore: 200000,
        messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, keepRecentTokens: 20000, reserveTokens: 16384 } },
    }, async () => ({ text: "A new summary cannot recover older omitted facts." }));
    manager.appendCompaction(result.compaction!.summary, user, 200000, result.compaction!.details, true);
    expect(contextLoss(manager.getBranch())).toBe("loss-boundary");
    expect(pendingContextWarning(manager)).toBeUndefined();
  });
});
