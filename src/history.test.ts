import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { createHistoryManager, type HistoryManager } from "../src/history.js";

describe("HistoryManager", () => {
  let tempDir: string;
  let historyManager: HistoryManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/pibot-test-");
    historyManager = createHistoryManager(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return empty array for new history", async () => {
    const messages = await historyManager.getRecent(10, 1000);
    expect(messages).toEqual([]);
  });

  it("should append and retrieve messages", async () => {
    await historyManager.append({
      role: "user",
      content: "Hello",
    });

    const messages = await historyManager.getRecent(10, 1000);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello");
  });

  it("should respect max messages limit", async () => {
    for (let i = 0; i < 15; i++) {
      await historyManager.append({
        role: "user",
        content: `Message ${i}`,
      });
    }

    const messages = await historyManager.getRecent(5, 10000);
    expect(messages.length).toBeLessThanOrEqual(5);
  });

  it("should clear all history", async () => {
    await historyManager.append({
      role: "user",
      content: "Hello",
    });

    await historyManager.clear();

    const messages = await historyManager.getRecent(10, 1000);
    expect(messages).toEqual([]);
  });

  it("should add timestamps to messages", async () => {
    await historyManager.append({
      role: "user",
      content: "Hello",
    });

    const messages = await historyManager.getRecent(10, 1000);
    expect(messages[0].timestamp).toBeDefined();
  });
});
