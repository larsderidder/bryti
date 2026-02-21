import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createFileTools } from "./files.js";

describe("FileTools", () => {
  let tempDir: string;
  let tools: ReturnType<typeof createFileTools>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync("/tmp/pibot-test-");
    tools = createFileTools(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("file_read", () => {
    it("should read a file", async () => {
      fs.writeFileSync(path.join(tempDir, "test.txt"), "Hello World", "utf-8");

      const readFileTool = tools.find((t) => t.name === "file_read")!;
      const result = await readFileTool.execute("call1", { path: "test.txt" }, undefined, undefined, undefined as any);

      expect(result.content[0]).toHaveProperty("text");
      const text = (result.content[0] as any).text;
      expect(text).toContain("Hello World");
    });

    it("should return error for nonexistent file", async () => {
      const readFileTool = tools.find((t) => t.name === "file_read")!;
      const result = await readFileTool.execute("call1", { path: "nonexistent.txt" }, undefined, undefined, undefined as any);

      expect(result.content[0]).toHaveProperty("text");
      const text = (result.content[0] as any).text;
      expect(text).toContain("not found");
    });

    it("should reject path traversal", async () => {
      const readFileTool = tools.find((t) => t.name === "file_read")!;
      const result = await readFileTool.execute("call1", { path: "../package.json" }, undefined, undefined, undefined as any);

      expect(result.content[0]).toHaveProperty("text");
      const text = (result.content[0] as any).text;
      expect(text).toContain("path traversal");
    });
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

      // Verify file was created
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
        { path: "../test.txt", content: "Malicious" },
        undefined,
        undefined,
        undefined as any,
      );

      expect(result.content[0]).toHaveProperty("text");
      const text = (result.content[0] as any).text;
      expect(text).toContain("path traversal");
    });
  });

  describe("file_list", () => {
    it("should list files in directory", async () => {
      fs.writeFileSync(path.join(tempDir, "file1.txt"), "content1");
      fs.writeFileSync(path.join(tempDir, "file2.txt"), "content2");
      fs.mkdirSync(path.join(tempDir, "subdir"));
      fs.writeFileSync(path.join(tempDir, "subdir", "file3.txt"), "content3");

      const listFilesTool = tools.find((t) => t.name === "file_list")!;
      const result = await listFilesTool.execute("call1", { directory: undefined }, undefined, undefined, undefined as any);

      expect(result.content[0]).toHaveProperty("text");
      const text = (result.content[0] as any).text;
      expect(text).toContain("file1.txt");
      expect(text).toContain("file2.txt");
    });

    it("should list files in subdirectory", async () => {
      fs.mkdirSync(path.join(tempDir, "notes"));
      fs.writeFileSync(path.join(tempDir, "notes", "todo.md"), "- task 1");

      const listFilesTool = tools.find((t) => t.name === "file_list")!;
      const result = await listFilesTool.execute("call1", { directory: "notes" }, undefined, undefined, undefined as any);

      expect(result.content[0]).toHaveProperty("text");
      const text = (result.content[0] as any).text;
      expect(text).toContain("todo.md");
    });
  });
});
