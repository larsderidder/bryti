import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkerScopedTools } from "./scoped-tools.js";

describe("Worker scoped tools", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibot-scoped-tools-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("write_file creates a file in the worker directory", async () => {
    const tools = createWorkerScopedTools(tempDir);
    const writeTool = tools.find((t) => t.name === "write_file")!;

    const result = await writeTool.execute("c1", {
      filename: "result.md",
      content: "# Findings\n\nSome research.",
    });
    const details = result.details as any;

    expect(details.success).toBe(true);
    expect(details.filename).toBe("result.md");
    expect(fs.existsSync(path.join(tempDir, "result.md"))).toBe(true);
    expect(fs.readFileSync(path.join(tempDir, "result.md"), "utf-8")).toBe(
      "# Findings\n\nSome research.",
    );
  });

  it("write_file rejects path traversal", async () => {
    const tools = createWorkerScopedTools(tempDir);
    const writeTool = tools.find((t) => t.name === "write_file")!;

    const result = await writeTool.execute("c1", {
      filename: "../escape.md",
      content: "escape attempt",
    });
    expect((result.details as any).error).toMatch(/invalid filename/i);
  });

  it("write_file rejects subdirectory paths", async () => {
    const tools = createWorkerScopedTools(tempDir);
    const writeTool = tools.find((t) => t.name === "write_file")!;

    const result = await writeTool.execute("c1", {
      filename: "sub/dir/file.md",
      content: "nested",
    });
    expect((result.details as any).error).toMatch(/invalid filename/i);
  });

  it("write_file rejects hidden files", async () => {
    const tools = createWorkerScopedTools(tempDir);
    const writeTool = tools.find((t) => t.name === "write_file")!;

    const result = await writeTool.execute("c1", {
      filename: ".hidden",
      content: "hidden file",
    });
    expect((result.details as any).error).toMatch(/invalid filename/i);
  });

  it("write_file rejects reserved filenames", async () => {
    const tools = createWorkerScopedTools(tempDir);
    const writeTool = tools.find((t) => t.name === "write_file")!;

    for (const reserved of ["status.json", "task.md", "steering.md"]) {
      const result = await writeTool.execute("c1", {
        filename: reserved,
        content: "overwrite attempt",
      });
      expect((result.details as any).error).toMatch(/invalid filename/i);
    }
  });

  it("read_file reads a previously written file", async () => {
    const tools = createWorkerScopedTools(tempDir);
    const writeTool = tools.find((t) => t.name === "write_file")!;
    const readTool = tools.find((t) => t.name === "read_file")!;

    await writeTool.execute("c1", {
      filename: "notes.md",
      content: "some notes",
    });

    const result = await readTool.execute("c2", { filename: "notes.md" });
    const details = result.details as any;
    expect(details.content).toBe("some notes");
  });

  it("read_file rejects path traversal", async () => {
    const tools = createWorkerScopedTools(tempDir);
    const readTool = tools.find((t) => t.name === "read_file")!;

    const result = await readTool.execute("c1", { filename: "../../etc/passwd" });
    expect((result.details as any).error).toMatch(/invalid filename/i);
  });

  it("read_file returns error for non-existent file", async () => {
    const tools = createWorkerScopedTools(tempDir);
    const readTool = tools.find((t) => t.name === "read_file")!;

    const result = await readTool.execute("c1", { filename: "nope.md" });
    expect((result.details as any).error).toMatch(/not found/i);
  });

  it("write_file rejects oversized content", async () => {
    const tools = createWorkerScopedTools(tempDir);
    const writeTool = tools.find((t) => t.name === "write_file")!;

    const bigContent = "x".repeat(101 * 1024);
    const result = await writeTool.execute("c1", {
      filename: "big.md",
      content: bigContent,
    });
    expect((result.details as any).error).toMatch(/too large/i);
  });
});
