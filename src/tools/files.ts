/**
 * File tools.
 *
 * - file_read: reads any file on the filesystem (unsandboxed).
 * - file_write: sandboxed to data/files/ with path traversal protection.
 * - file_list: sandboxed to data/files/ with path traversal protection.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { toolError, toolSuccess } from "./result.js";

const MAX_FILE_SIZE = 50 * 1024; // 50KB
const MAX_DEPTH = 3;

// Schema for read_file — accepts absolute or relative paths
const readFileSchema = Type.Object({
  path: Type.String({
    description:
      "Path to read. Absolute paths read from the filesystem directly. " +
      "Relative paths are resolved from the sandboxed files directory.",
  }),
});

type ReadFileInput = Static<typeof readFileSchema>;

// Schema for write_file — sandboxed
const writeFileSchema = Type.Object({
  path: Type.String({ description: "Relative path to the file (e.g., 'notes/todo.md')" }),
  content: Type.String({ description: "Content to write to the file" }),
});

type WriteFileInput = Static<typeof writeFileSchema>;

// Schema for list_files — absolute paths go anywhere, relative from sandbox
const listFilesSchema = Type.Object({
  directory: Type.Optional(Type.String({
    description:
      "Directory to list. Absolute paths list from the filesystem directly. " +
      "Relative paths are resolved from the sandboxed files directory. " +
      "Omit to list the sandboxed files directory root.",
  })),
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
    name: "file_read",
    label: "file_read",
    description:
      "Read the contents of a file. Accepts absolute paths to read from anywhere " +
      "on the filesystem, or relative paths which resolve from the sandboxed files directory.",
    parameters: readFileSchema,
    async execute(
      _toolCallId: string,
      { path: filePath }: ReadFileInput,
    ): Promise<AgentToolResult<unknown>> {
      // Absolute paths read directly; relative paths resolve from sandbox
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(baseDir, filePath);

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
    name: "file_write",
    label: "file_write",
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
    name: "file_list",
    label: "file_list",
    description:
      "List files and directories. Accepts absolute paths to list from anywhere " +
      "on the filesystem, or relative paths which resolve from the sandboxed files directory. " +
      "Omit directory to list the sandboxed files root.",
    parameters: listFilesSchema,
    async execute(
      _toolCallId: string,
      { directory }: ListFilesInput,
    ): Promise<AgentToolResult<unknown>> {
      let targetDir = baseDir;
      let relativeBase = baseDir;

      if (directory) {
        // Absolute paths list from anywhere; relative from sandbox
        if (path.isAbsolute(directory)) {
          targetDir = directory;
          relativeBase = directory;
        } else {
          const resolved = resolveSafePath(baseDir, directory);
          if (!resolved) return toolError("Invalid path: path traversal not allowed");
          targetDir = resolved;
        }
        if (!fs.existsSync(targetDir)) return toolError("Directory not found");
        if (!fs.statSync(targetDir).isDirectory()) return toolError("Path is not a directory");
      }

      try {
        const entries: string[] = [];

        function walkDir(currentDir: string, depth: number): void {
          if (depth > MAX_DEPTH) return;
          for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const fullPath = path.join(currentDir, entry.name);
            const rel = path.relative(relativeBase, fullPath);
            if (entry.isFile()) {
              entries.push(rel);
            } else if (entry.isDirectory()) {
              entries.push(rel + "/");
              walkDir(fullPath, depth + 1);
            }
          }
        }

        walkDir(targetDir, 0);
        return toolSuccess({ files: entries });
      } catch (error) {
        return toolError(error, "Failed to list directory");
      }
    },
  };

  return [readFileTool, writeFileTool, listFilesTool];
}
