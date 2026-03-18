import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createFileTools } from "./files.js";

describe("FileTools", () => {
  let tempDir: string;
  let tools: ReturnType<typeof createFileTools>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/bryti-test-");
    tools = createFileTools(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("file_write", () => {
    it("should write a file", async () => {
      const writeFileTool = tools.find((t) => t.name === "file_write")!;
      const result = await writeFileTool.execute(
        "call1",
        { path: "newfile.txt", content: "Test content" },
        undefined,
        undefined,
        undefined as any,
      );

      expect(result.content[0]).toHaveProperty("text");
      const text = (result.content[0] as any).text;
      expect(text).toContain("success");

      const fileContent = fs.readFileSync(path.join(tempDir, "newfile.txt"), "utf-8");
      expect(fileContent).toBe("Test content");
    });

    it("should create parent directories", async () => {
      const writeFileTool = tools.find((t) => t.name === "file_write")!;
      await writeFileTool.execute(
        "call1",
        { path: "subdir/nested/file.txt", content: "Nested" },
        undefined,
        undefined,
        undefined as any,
      );

      const fileContent = fs.readFileSync(path.join(tempDir, "subdir/nested/file.txt"), "utf-8");
      expect(fileContent).toBe("Nested");
    });

    it("should reject path traversal", async () => {
      const writeFileTool = tools.find((t) => t.name === "file_write")!;
      const result = await writeFileTool.execute(
        "call1",
        { path: "../escape.txt", content: "Malicious" },
        undefined,
        undefined,
        undefined as any,
      );

      const text = (result.content[0] as any).text;
      expect(text).toContain("path traversal");
      expect(fs.existsSync(path.join(tempDir, "..", "escape.txt"))).toBe(false);
    });

    it("should reject absolute paths", async () => {
      const writeFileTool = tools.find((t) => t.name === "file_write")!;
      const result = await writeFileTool.execute(
        "call1",
        { path: "/tmp/absolute.txt", content: "Nope" },
        undefined,
        undefined,
        undefined as any,
      );

      const text = (result.content[0] as any).text;
      expect(text).toContain("relative");
    });

    it("only registers file_write — read and ls come from the SDK", () => {
      const names = tools.map((t) => t.name);
      expect(names).toEqual(["file_write"]);
      expect(names).not.toContain("file_read");
      expect(names).not.toContain("file_list");
    });
  });
});
