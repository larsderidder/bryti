/**
 * system_log tool: read recent application log entries.
 *
 * Gives the agent visibility into its own runtime errors, worker events,
 * scheduler output, and other operational messages without needing shell
 * access.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { toolError, toolSuccess } from "./result.js";

const systemLogSchema = Type.Object({
  lines: Type.Optional(Type.Number({
    description: "Number of most recent log lines to return (default: 50, max: 200).",
  })),
  level: Type.Optional(Type.String({
    description: "Filter by log level: 'error', 'warn', 'info', 'debug'. Returns all levels if omitted.",
  })),
  search: Type.Optional(Type.String({
    description: "Filter lines containing this text (case-insensitive).",
  })),
});

type SystemLogInput = Static<typeof systemLogSchema>;

/**
 * Read recent lines from today's (and optionally yesterday's) JSONL log file.
 */
export function createSystemLogTool(logsDir: string): AgentTool<typeof systemLogSchema> {
  return {
    name: "system_log",
    label: "system_log",
    description:
      "Read recent application log entries. Use to diagnose errors, check worker " +
      "status, review scheduler activity, or understand why something failed. " +
      "Shows timestamped entries with level (info/warn/error/debug).",
    parameters: systemLogSchema,
    async execute(
      _toolCallId: string,
      params: SystemLogInput,
    ): Promise<AgentToolResult<unknown>> {
      const maxLines = Math.min(params.lines ?? 50, 200);
      const levelFilter = params.level?.toLowerCase();
      const searchFilter = params.search?.toLowerCase();

      // Collect lines from today's log, falling back to yesterday if today is empty
      const lines: string[] = [];
      const today = new Date().toISOString().split("T")[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

      for (const date of [yesterday, today]) {
        const logFile = path.join(logsDir, `${date}.jsonl`);
        if (!fs.existsSync(logFile)) continue;

        const content = fs.readFileSync(logFile, "utf-8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          lines.push(line);
        }
      }

      // Filter and take the last N lines
      let filtered = lines;

      if (levelFilter) {
        filtered = filtered.filter((line) => {
          try {
            const entry = JSON.parse(line) as { level?: string };
            return entry.level === levelFilter;
          } catch {
            return false;
          }
        });
      }

      if (searchFilter) {
        filtered = filtered.filter((line) => line.toLowerCase().includes(searchFilter));
      }

      const recent = filtered.slice(-maxLines);

      if (recent.length === 0) {
        return toolSuccess({ message: "No log entries found matching the criteria." });
      }

      // Format for readability
      const formatted = recent.map((line) => {
        try {
          const entry = JSON.parse(line) as { timestamp: string; level: string; message: string };
          return `${entry.timestamp} [${entry.level.toUpperCase()}] ${entry.message}`;
        } catch {
          return line;
        }
      });

      return toolSuccess({
        entries: formatted.join("\n"),
        count: recent.length,
        total_available: filtered.length,
      });
    },
  };
}
