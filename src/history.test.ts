import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHistoryManager, type HistoryManager } from "../src/history.js";

describe("HistoryManager", () => {
  let tempDir: string;
  let historyManager: HistoryManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/bryti-test-");
    historyManager = createHistoryManager(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should append a message to the history file", async () => {
    await historyManager.append({
      role: "user",
      content: "Hello",
    });

    const historyDir = path.join(tempDir, "history");
    const files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);

    const line = fs.readFileSync(path.join(historyDir, files[0]), "utf-8").trim();
    const record = JSON.parse(line);
    expect(record.role).toBe("user");
    expect(record.content).toBe("Hello");
    expect(record.timestamp).toBeDefined();
  });

  it("should clear all history files", async () => {
    await historyManager.append({ role: "user", content: "Hello" });
    await historyManager.clear();

    const historyDir = path.join(tempDir, "history");
    const files = fs.existsSync(historyDir)
      ? fs.readdirSync(historyDir).filter((f) => f.endsWith(".jsonl"))
      : [];
    expect(files).toHaveLength(0);
  });

  it("should add timestamps to messages", async () => {
    const before = new Date().toISOString();
    await historyManager.append({ role: "user", content: "Hello" });
    const after = new Date().toISOString();

    const historyDir = path.join(tempDir, "history");
    const files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".jsonl"));
    const line = fs.readFileSync(path.join(historyDir, files[0]), "utf-8").trim();
    const record = JSON.parse(line);

    expect(record.timestamp >= before).toBe(true);
    expect(record.timestamp <= after).toBe(true);
  });
});
