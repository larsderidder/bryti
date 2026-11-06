import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { openBoundedSession, trimSessionCache } from "./session-loading.js";
import { createWorkStore } from "../work/store.js";
import { EffectStore } from "../work/effects.js";
import { inspectWorkRecovery, reconcileWorkAsOperator } from "../work/recovery.js";
import type { UserSession } from "../agent.js";
import { acquireSessionTurn } from "./proactive.js";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-session-loading-")); });

function cachedSession(lastUserMessageAt: number): UserSession {
  return { lastUserMessageAt, session: { isStreaming: false, isCompacting: false }, dispose: vi.fn() } as unknown as UserSession;
}

it("evicts the oldest idle cache entry but never active or leased sessions", async () => {
  const idle = cachedSession(1);
  const busy = cachedSession(2);
  const protectedSession = cachedSession(3);
  const cache = new Map([["idle", idle], ["busy", busy], ["protected", protectedSession]]);
  const release = await acquireSessionTurn(busy);
  try {
    await trimSessionCache(cache, "protected", { maxSessions: 2, isBusy: () => true });
    expect(idle.dispose).not.toHaveBeenCalled();
    await trimSessionCache(cache, "protected", { maxSessions: 2 });
    expect(idle.dispose).toHaveBeenCalledOnce();
    expect(cache.has("idle")).toBe(false);
    expect(cache.has("busy")).toBe(true);
    expect(cache.has("protected")).toBe(true);
    expect(busy.dispose).not.toHaveBeenCalled();
  } finally {
    release();
  }
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("bounded persistent session loading", () => {
  it("continues an ordinary session without changing its identity", () => {
    const original = SessionManager.create(directory, directory);
    original.appendMessage({ role: "user", content: "Keep the conversation", timestamp: 1 });
    const loaded = openBoundedSession(directory, directory);
    expect(loaded.getSessionId()).toBe(original.getSessionId());
    expect(loaded.buildSessionContext().messages).toContainEqual(expect.objectContaining({ content: "Keep the conversation" }));
  });

  it("creates a bounded successor without modifying or replaying the archived session", () => {
    const original = SessionManager.create(directory, directory);
    original.appendMessage({ role: "user", content: "Do not publish anything", timestamp: 1 });
    original.appendMessage(fauxAssistantMessage(fauxToolCall("publish", { text: "An uncertain old action" }), { stopReason: "aborted" }));
    original.appendCompaction("Do not publish. The earlier publication is uncertain.", null, 200000);
    for (let index = 0; index < 12; index++) {
      original.appendMessage({ role: "user", content: "Historical context ".repeat(1000), timestamp: index + 2 });
    }
    const file = original.getSessionFile()!;
    const before = fs.readFileSync(file);
    const loaded = openBoundedSession(directory, directory, 100000);
    expect(loaded.getSessionId()).not.toBe(original.getSessionId());
    expect(loaded.getHeader()?.parentSession).toBe(file);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.statSync(loaded.getSessionFile()!).size).toBeLessThan(100000);
    const messages = loaded.buildSessionContext().messages;
    expect(JSON.stringify(messages)).toContain("Do not publish");
    expect(JSON.stringify(messages)).toContain("uncertain");
    expect(messages.some((message) => message.role === "assistant")).toBe(false);
    expect(JSON.stringify(messages)).toContain("not a new request");
    expect(openBoundedSession(directory, directory, 100000).getSessionId()).toBe(loaded.getSessionId());
  });

  it("skips an oversized historical line without loading it into the successor", () => {
    const original = SessionManager.create(directory, directory);
    original.appendMessage({ role: "user", content: "huge historical output ".repeat(100000), timestamp: 1 });
    const loaded = openBoundedSession(directory, directory, 100000);
    expect(fs.statSync(loaded.getSessionFile()!).size).toBeLessThan(100000);
    expect(JSON.stringify(loaded.buildSessionContext().messages)).toContain("omitted");
    expect(fs.existsSync(original.getSessionFile()!)).toBe(true);
  });

  it("preserves durable unknown effects and delivery blockers across context loss", () => {
    const work = createWorkStore(directory);
    const effects = new EffectStore(directory);
    try {
      const receipt = work.accept({ userId: "owner", channelId: "chat", platform: "telegram", text: "Earlier publication", raw: null }).record;
      work.claim([receipt.id]);
      const effect = effects.accept(receipt.message, "publish-call", "publish", { title: "An uncertain publication" }, "implementation").receipt;
      effects.finish(effect.id);
      work.finish([receipt.id], "interrupted");
      work.recordDelivery([receipt.id], "unknown");
      const original = SessionManager.create(directory, directory);
      original.appendMessage({ role: "user", content: "Old context ".repeat(100000), timestamp: 1 });
      openBoundedSession(directory, directory, 100000);
      const state = inspectWorkRecovery(directory, receipt.id);
      expect(state.blockers).toContainEqual(expect.stringMatching(/effects/i));
      expect(() => reconcileWorkAsOperator(directory, "owner", receipt.id, "Context was compacted")).toThrow();
      expect(work.get(receipt.id)).toMatchObject({ execution: "interrupted", delivery: "unknown" });
    } finally {
      effects.close();
      work.close();
    }
  });
});
