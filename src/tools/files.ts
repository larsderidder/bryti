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
      if (!resolved) {
        const text = JSON.stringify({ error: "Invalid path: path traversal not allowed" });
        return {
          content: [{ type: "text", text }],
          details: { error: "Invalid path" },
        };
      }

      try {
        if (!fs.existsSync(resolved)) {
          const text = JSON.stringify({ error: "File not found" });
          return {
            content: [{ type: "text", text }],
            details: { error: "File not found" },
          };
        }

        const stats = fs.statSync(resolved);
        if (stats.isDirectory()) {
          const text = JSON.stringify({ error: "Path is a directory, not a file" });
          return {
            content: [{ type: "text", text }],
            details: { error: "Is a directory" },
          };
        }

        if (stats.size > MAX_FILE_SIZE) {
          const content = fs.readFileSync(resolved, "utf-8").slice(0, MAX_FILE_SIZE);
          const text = JSON.stringify({
            content: content + "\n\n[File truncated, was larger than 50KB]",
            truncated: true,
          }, null, 2);
          return {
            content: [{ type: "text", text }],
            details: { truncated: true },
          };
        }

        const content = fs.readFileSync(resolved, "utf-8");
        const text = JSON.stringify({ content }, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { content },
        };
      } catch (error) {
        const err = error as Error;
        const text = JSON.stringify({ error: `Failed to read file: ${err.message}` });
        return {
          content: [{ type: "text", text }],
          details: { error: err.message },
        };
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
      if (!resolved) {
        const text = JSON.stringify({ error: "Invalid path: path traversal not allowed" });
        return {
          content: [{ type: "text", text }],
          details: { error: "Invalid path" },
        };
      }

      try {
        // Create parent directories if needed
        const dir = path.dirname(resolved);
        fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(resolved, content, "utf-8");
        const bytes = Buffer.byteLength(content, "utf-8");
        const text = JSON.stringify({ success: true, bytes }, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { success: true, bytes },
        };
      } catch (error) {
        const err = error as Error;
        const text = JSON.stringify({ error: `Failed to write file: ${err.message}` });
        return {
          content: [{ type: "text", text }],
          details: { error: err.message },
        };
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
        if (!resolved) {
          const text = JSON.stringify({ error: "Invalid path: path traversal not allowed" });
          return {
            content: [{ type: "text", text }],
            details: { error: "Invalid path" },
          };
        }
        if (!fs.existsSync(resolved)) {
          const text = JSON.stringify({ error: "Directory not found" });
          return {
            content: [{ type: "text", text }],
            details: { error: "Directory not found" },
          };
        }
        targetDir = resolved;
      }

      try {
        const files: string[] = [];

        function walkDir(currentDir: string, depth: number): void {
          if (depth > MAX_DEPTH) return;

          const entries = fs.readdirSync(currentDir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(baseDir, fullPath);

            if (entry.isFile()) {
              files.push(relativePath);
            } else if (entry.isDirectory()) {
              walkDir(fullPath, depth + 1);
            }
          }
        }

        walkDir(targetDir, 0);
        const text = JSON.stringify({ files }, null, 2);
        return {
          content: [{ type: "text", text }],
          details: { files },
        };
      } catch (error) {
        const err = error as Error;
        const text = JSON.stringify({ error: `Failed to list files: ${err.message}` });
        return {
          content: [{ type: "text", text }],
          details: { error: err.message },
        };
      }
    },
  };

  return [readFileTool, writeFileTool, listFilesTool];
}
