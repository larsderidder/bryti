/**
 * Scoped tools for workers.
 *
 * Workers get a minimal tool set: read and write files in their own directory.
 * No access to other directories, no shell, no memory. Which tools a worker
 * gets will eventually be operator-configurable; for now it's hardcoded.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { toolError, toolSuccess } from "../tools/result.js";

const MAX_FILE_SIZE = 100 * 1024; // 100KB — workers may write longer research docs

const writeResultSchema = Type.Object({
  filename: Type.String({
    description:
      'Filename to write (e.g., "result.md", "sources.md"). No subdirectories allowed.',
  }),
  content: Type.String({ description: "Content to write to the file." }),
});

type WriteResultInput = Static<typeof writeResultSchema>;

const readResultSchema = Type.Object({
  filename: Type.String({
    description: 'Filename to read (e.g., "result.md"). Must be a file the worker previously wrote.',
  }),
});

type ReadResultInput = Static<typeof readResultSchema>;

/**
 * Validate filename: no path separators, no traversal, no hidden files.
 *
 * Reserved filenames that workers must not overwrite:
 *   - status.json  : written by spawn.ts to record worker status; read by
 *                    worker_check to report progress back to the main agent.
 *   - task.md      : the initial task brief written by worker_dispatch; treated
 *                    as read-only so the worker always has access to its original
 *                    instructions even if steering changes direction.
 *   - steering.md  : the communication channel from the main agent to a running
 *                    worker; written exclusively by worker_steer so the worker
 *                    can safely poll it without racing against its own writes.
 */
function isValidFilename(filename: string): boolean {
  if (!filename || filename.length > 255) return false;
  if (filename.includes("/") || filename.includes("\\")) return false;
  if (filename.startsWith(".")) return false;
  if (filename === "status.json" || filename === "task.md" || filename === "steering.md") return false; // reserved
  return true;
}

/**
 * Create scoped file tools (write_file, read_file) for a worker session.
 *
 * Isolation guarantees:
 *   - Workers can only write to their own workerDir (flat layout, no subdirectories).
 *   - Workers can only read files that live in the same workerDir, which means
 *     only files they wrote themselves plus task.md and steering.md. There is no
 *     cross-worker access and no parent-directory traversal.
 *   - Reserved filenames (status.json, task.md, steering.md) are blocked from
 *     writes so the runtime's control files cannot be corrupted.
 */
export function createWorkerScopedTools(workerDir: string): AgentTool<any>[] {
  const writeTool: AgentTool<typeof writeResultSchema> = {
    name: "write_file",
    label: "write_file",
    description:
      "Write content to a file in your working directory. " +
      "Use result.md for your main findings. You can also create additional files like sources.md or notes.md.",
    parameters: writeResultSchema,
    async execute(
      _toolCallId: string,
      { filename, content }: WriteResultInput,
    ): Promise<AgentToolResult<unknown>> {
      if (!isValidFilename(filename)) {
        return toolError(
          "Invalid filename. Use a simple name like 'result.md'. No paths, no hidden files.",
        );
      }

      if (Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE) {
        return toolError(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024}KB.`);
      }

      try {
        const filePath = path.join(workerDir, filename);
        fs.writeFileSync(filePath, content, "utf-8");
        return toolSuccess({
          success: true,
          filename,
          bytes: Buffer.byteLength(content, "utf-8"),
        });
      } catch (error) {
        return toolError(error, "Failed to write file");
      }
    },
  };

  const readTool: AgentTool<typeof readResultSchema> = {
    name: "read_file",
    label: "read_file",
    description:
      "Read a file you previously wrote in your working directory.",
    parameters: readResultSchema,
    async execute(
      _toolCallId: string,
      { filename }: ReadResultInput,
    ): Promise<AgentToolResult<unknown>> {
      if (!isValidFilename(filename)) {
        return toolError("Invalid filename.");
      }

      try {
        const filePath = path.join(workerDir, filename);
        if (!fs.existsSync(filePath)) {
          return toolError(`File not found: ${filename}`);
        }
        const content = fs.readFileSync(filePath, "utf-8");
        return toolSuccess({ filename, content });
      } catch (error) {
        return toolError(error, "Failed to read file");
      }
    },
  };

  return [writeTool, readTool];
}
