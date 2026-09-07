import { describe, expect, it, vi, afterEach } from "vitest";
import type { UserSession } from "../agent.js";
import { acquireSessionTurn, isProactiveCompactionRunning, tryCompact } from "./proactive.js";

function makeUserSession(options: {
  isCompacting?: boolean;
  isStreaming?: boolean;
  percent?: number;
  messageCount?: number;
  compact?: (instructions: string) => Promise<void>;
} = {}): UserSession {
  const messageCount = options.messageCount ?? 6;
  return {
    userId: "user-1",
    sessionDir: "/tmp/session",
    lastUserMessageAt: Date.now() - 60 * 60 * 1000,
    extensionErrors: [],
    modelRegistry: {} as any,
    projectionStore: { close() {} } as any,
    dispose() {},
    session: {
      isCompacting: options.isCompacting ?? false,
      isStreaming: options.isStreaming ?? false,
      messages: Array.from({ length: messageCount }, () => ({
        role: "assistant",
        content: [],
      })),
      getContextUsage() {
        return {
          percent: options.percent ?? 50,
          tokens: 50_000,
          contextWindow: 100_000,
        };
      },
      compact: options.compact ?? vi.fn().mockResolvedValue(undefined),
    } as any,
  } as UserSession;
}

describe("tryCompact", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips proactive compaction while the session is streaming", async () => {
    const compact = vi.fn().mockResolvedValue(undefined);
    const userSession = makeUserSession({ compact, isStreaming: true });

    await tryCompact(userSession, "idle");

    expect(compact).not.toHaveBeenCalled();
  });

  it("marks the session as compacting while proactive compaction is running", async () => {
    let finishCompact!: () => void;
    const compact = vi.fn(() => new Promise<void>((resolve) => {
      finishCompact = resolve;
    }));
    const userSession = makeUserSession({ compact });

    const running = tryCompact(userSession, "idle");
    await Promise.resolve();

    expect(isProactiveCompactionRunning(userSession)).toBe(true);

    finishCompact();
    await running;

    expect(isProactiveCompactionRunning(userSession)).toBe(false);
  });

  it("does not start a second proactive compaction for the same session", async () => {
    let finishCompact!: () => void;
    const compact = vi.fn(() => new Promise<void>((resolve) => {
      finishCompact = resolve;
    }));
    const userSession = makeUserSession({ compact });

    const first = tryCompact(userSession, "idle");
    await Promise.resolve();
    await tryCompact(userSession, "nightly");

    finishCompact();
    await first;

    expect(compact).toHaveBeenCalledOnce();
  });

  it("skips proactive compaction while a session turn is reserved", async () => {
    const compact = vi.fn().mockResolvedValue(undefined);
    const userSession = makeUserSession({ compact });
    const release = await acquireSessionTurn(userSession);

    await tryCompact(userSession, "idle");
    release();

    expect(compact).not.toHaveBeenCalled();
  });

  it("reserves a session turn synchronously before waiting for active compaction", async () => {
    let finishCompact!: () => void;
    const compact = vi.fn(() => new Promise<void>((resolve) => {
      finishCompact = resolve;
    }));
    const userSession = makeUserSession({ compact });

    const first = tryCompact(userSession, "idle");
    await Promise.resolve();

    const acquiring = acquireSessionTurn(userSession);
    await tryCompact(userSession, "nightly");
    expect(compact).toHaveBeenCalledOnce();

    finishCompact();
    await first;
    const release = await acquiring;
    release();
  });
});
