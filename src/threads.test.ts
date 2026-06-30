import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createThread, getActiveThread, getSessionKey, listThreads, switchThread } from "./threads.js";

let tempDir = "";

function dataDir(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-threads-"));
  return tempDir;
}

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("threads", () => {
  it("starts every user on the main thread", () => {
    expect(getActiveThread(dataDir(), "123")).toBe("main");
  });

  it("creates and switches to a sanitized thread", () => {
    const dir = dataDir();

    const thread = createThread(dir, "123", "Tax stuff 2026!");

    expect(thread.id).toBe("tax-stuff-2026");
    expect(getActiveThread(dir, "123")).toBe("tax-stuff-2026");
    expect(listThreads(dir, "123")).toEqual([
      { id: "main", title: "main", active: false },
      { id: "tax-stuff-2026", title: "Tax stuff 2026!", active: true },
    ]);
  });

  it("switches by title or slug", () => {
    const dir = dataDir();
    createThread(dir, "123", "Article Draft");

    expect(switchThread(dir, "123", "article-draft")?.id).toBe("article-draft");
    expect(switchThread(dir, "123", "Article Draft")?.id).toBe("article-draft");
  });

  it("keeps the main session key backwards compatible", () => {
    expect(getSessionKey("123", "main")).toBe("123");
    expect(getSessionKey("123", "taxes")).toBe("123__thread__taxes");
  });
});
