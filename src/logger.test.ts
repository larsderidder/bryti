import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createAppLogger } from "../src/logger.js";

describe("AppLogger", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/pibot-log-test-");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes structured JSONL records", () => {
    const logger = createAppLogger(tempDir);
    const err = new Error("boom");

    logger.info("startup", { foo: "bar" });
    logger.error("failed", err);

    const today = new Date().toISOString().split("T")[0];
    const logPath = path.join(tempDir, "logs", `${today}.jsonl`);
    expect(fs.existsSync(logPath)).toBe(true);

    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]) as {
      timestamp: string;
      level: string;
      message: string;
      args: Array<{ foo?: string }>;
    };
    expect(first.timestamp).toBeDefined();
    expect(first.level).toBe("info");
    expect(first.message).toBe("startup");
    expect(first.args[0].foo).toBe("bar");

    const second = JSON.parse(lines[1]) as {
      level: string;
      message: string;
      args: Array<{ name?: string; message?: string; stack?: string }>;
    };
    expect(second.level).toBe("error");
    expect(second.message).toBe("failed");
    expect(second.args[0].name).toBe("Error");
    expect(second.args[0].message).toBe("boom");
    expect(typeof second.args[0].stack).toBe("string");
  });
});
