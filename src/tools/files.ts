/**
 * File write tool.
 *
 * file_write: sandboxed to the data directory (config.data_dir) with path
 * traversal protection. The agent uses the SDK's built-in `read` and `ls`
 * tools for reading — they handle absolute paths, offset/limit pagination,
 * and image attachments, all of which our custom tool did not.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { toolError, toolSuccess } from "./result.js";

// Schema for file_write — sandboxed to data dir
const writeFileSchema = Type.Object({
  path: Type.String({
    description:
      "Relative path within the data directory (e.g., 'files/notes/todo.md', 'skills/my-skill/SKILL.md'). " +
      "Parent directories are created automatically.",
  }),
  content: Type.String({ description: "Content to write to the file" }),
});

type WriteFileInput = Static<typeof writeFileSchema>;

/**
 * Resolve path and verify it stays under baseDir (path traversal protection).
 */
function resolveSafePath(baseDir: string, filePath: string): string | null {
  const resolved = path.resolve(baseDir, filePath);
  const baseResolved = path.resolve(baseDir);

  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    return null;
  }

  return resolved;
}

/**
 * Create the file_write tool sandboxed to dataDir.
 */
export function createFileTools(dataDir: string): AgentTool<any>[] {
  fs.mkdirSync(dataDir, { recursive: true });

  const writeFileTool: AgentTool<typeof writeFileSchema> = {
    name: "file_write",
    label: "file_write",
    description:
      "Write content to a file inside the data directory. " +
      "Use relative paths (e.g., 'files/notes/todo.md', 'skills/my-skill/SKILL.md', 'config.yml'). " +
      "Parent directories are created automatically. " +
      "To read files or list directories, use the built-in `read` and `ls` tools instead — " +
      "they support absolute paths, pagination, and images.",
    parameters: writeFileSchema,
    async execute(
      _toolCallId: string,
      { path: filePath, content }: WriteFileInput,
    ): Promise<AgentToolResult<unknown>> {
      if (path.isAbsolute(filePath)) {
        return toolError(
          "file_write only accepts relative paths within the data directory. " +
          "Use a relative path like 'files/notes/foo.md' rather than an absolute path.",
        );
      }

      const resolved = resolveSafePath(dataDir, filePath);
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

  return [writeFileTool];
}
