/**
 * Sandboxed file read/write/list tools.
 *
 * Operates within the user's /data/files/ directory.
 * Path traversal protection: resolve and verify under base_dir.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { toolError, toolSuccess } from "./result.js";

const MAX_FILE_SIZE = 50 * 1024; // 50KB
const MAX_DEPTH = 3;

// Schema for read_file
const readFileSchema = Type.Object({
  path: Type.String({ description: "Relative path to the file (e.g., 'notes/todo.md')" }),
});

type ReadFileInput = Static<typeof readFileSchema>;

// Schema for write_file
const writeFileSchema = Type.Object({
  path: Type.String({ description: "Relative path to the file (e.g., 'notes/todo.md')" }),
  content: Type.String({ description: "Content to write to the file" }),
});

type WriteFileInput = Static<typeof writeFileSchema>;

// Schema for list_files
const listFilesSchema = Type.Object({
  directory: Type.Optional(Type.String({ description: "Optional subdirectory to list (e.g., 'notes')" })),
});

type ListFilesInput = Static<typeof listFilesSchema>;

/**
 * Resolve path and verify it's under base_dir (path traversal protection).
 */
function resolveSafePath(baseDir: string, filePath: string): string | null {
  const resolved = path.resolve(baseDir, filePath);
  const baseResolved = path.resolve(baseDir);

  // Verify the resolved path is under base_dir
  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    return null;
  }

  return resolved;
}

/**
 * Create file tools.
 */
export function createFileTools(baseDir: string): AgentTool<any>[] {
  // Ensure base directory exists
  fs.mkdirSync(baseDir, { recursive: true });

  const readFileTool: AgentTool<typeof readFileSchema> = {
    name: "read_file",
    label: "read_file",
    description: "Read the contents of a file from the sandboxed files directory.",
    parameters: readFileSchema,
    async execute(
      _toolCallId: string,
      { path: filePath }: ReadFileInput,
    ): Promise<AgentToolResult<unknown>> {
      const resolved = resolveSafePath(baseDir, filePath);
      if (!resolved) return toolError("Invalid path: path traversal not allowed");

      try {
        if (!fs.existsSync(resolved)) return toolError("File not found");

        const stats = fs.statSync(resolved);
        if (stats.isDirectory()) return toolError("Path is a directory, not a file");

        if (stats.size > MAX_FILE_SIZE) {
          const content = fs.readFileSync(resolved, "utf-8").slice(0, MAX_FILE_SIZE);
          return toolSuccess({ content: content + "\n\n[File truncated, was larger than 50KB]", truncated: true });
        }

        return toolSuccess({ content: fs.readFileSync(resolved, "utf-8") });
      } catch (error) {
        return toolError(error, "Failed to read file");
      }
    },
  };

  const writeFileTool: AgentTool<typeof writeFileSchema> = {
    name: "write_file",
    label: "write_file",
    description: "Write content to a file in the sandboxed files directory. Creates parent directories if needed.",
    parameters: writeFileSchema,
    async execute(
      _toolCallId: string,
      { path: filePath, content }: WriteFileInput,
    ): Promise<AgentToolResult<unknown>> {
      const resolved = resolveSafePath(baseDir, filePath);
      if (!resolved) return toolError("Invalid path: path traversal not allowed");

      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, "utf-8");
        return toolSuccess({ success: true, bytes: Buffer.byteLength(content, "utf-8") });
      } catch (error) {
        return toolError(error, "Failed to write file");
      }
    },
  };

  const listFilesTool: AgentTool<typeof listFilesSchema> = {
    name: "list_files",
    label: "list_files",
    description: "List files in the sandboxed files directory, optionally under a subdirectory.",
    parameters: listFilesSchema,
    async execute(
      _toolCallId: string,
      { directory }: ListFilesInput,
    ): Promise<AgentToolResult<unknown>> {
      let targetDir = baseDir;

      if (directory) {
        const resolved = resolveSafePath(baseDir, directory);
        if (!resolved) return toolError("Invalid path: path traversal not allowed");
        if (!fs.existsSync(resolved)) return toolError("Directory not found");
        targetDir = resolved;
      }

      try {
        const files: string[] = [];

        function walkDir(currentDir: string, depth: number): void {
          if (depth > MAX_DEPTH) return;
          for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isFile()) {
              files.push(path.relative(baseDir, fullPath));
            } else if (entry.isDirectory()) {
              walkDir(fullPath, depth + 1);
            }
          }
        }

        walkDir(targetDir, 0);
        return toolSuccess({ files });
      } catch (error) {
        return toolError(error, "Failed to list files");
      }
    },
  };

  return [readFileTool, writeFileTool, listFilesTool];
}
