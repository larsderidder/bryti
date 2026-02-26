/**
 * Pi session awareness tools.
 *
 * Gives bryti read-only access to pi CLI sessions on disk. Bryti can see
 * what other agents are working on, check their progress, and surface
 * relevant info to the user.
 *
 * Sessions live at ~/.pi/agent/sessions/<encoded-dir>/<timestamp>_<uuid>.jsonl
 * The encoded dir replaces / with - and wraps with --.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { toolError, toolSuccess } from "./result.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function piSessionsDir(): string {
  return process.env.PI_SESSIONS_DIR
    ?? path.join(process.env.HOME ?? "", ".pi", "agent", "sessions");
}

function decodeDirectoryName(encoded: string): string {
  const inner = encoded.replace(/^-+|-+$/g, "");
  return "/" + inner.replace(/-/g, "/");
}

// ---------------------------------------------------------------------------
// Running session detection
// ---------------------------------------------------------------------------

function findRunningPiSessionIds(): Set<string> {
  const running = new Set<string>();
  try {
    const ps = execSync("ps aux", { timeout: 5000, encoding: "utf-8" });
    const uuidPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
    for (const line of ps.split("\n")) {
      if (!line.includes("pi-coding-agent") && !line.includes("/pi ")) continue;
      const match = uuidPattern.exec(line);
      if (match) running.add(match[1]);
    }
  } catch {
    // Best effort
  }
  return running;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

interface SessionRecord {
  type: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role: string;
    content: unknown;
    provider?: string;
    model?: string;
  };
}

function extractUserText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block?.type === "text" && block.text) parts.push(block.text);
    }
    return parts.join("\n").trim() || null;
  }
  return null;
}

function extractAssistantText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block?.type === "text" && block.text) parts.push(block.text);
    }
    return parts.join("\n").trim() || null;
  }
  return null;
}

interface SessionSummary {
  id: string;
  directory: string;
  firstPrompt: string | null;
  lastPrompt: string | null;
  lastActivity: string;
  messageCount: number;
  isRunning: boolean;
}

interface SessionMessage {
  role: string;
  content: string;
  timestamp: string | null;
}

function parseSessionFile(filePath: string, running: Set<string>): SessionSummary | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    let sessionId: string | null = null;
    let directory: string | null = null;
    let firstPrompt: string | null = null;
    let lastPrompt: string | null = null;
    let lastActivity: string | null = null;
    let messageCount = 0;

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let record: SessionRecord;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      if (record.timestamp) lastActivity = record.timestamp;

      if (record.type === "session") {
        sessionId = record.id ?? null;
        if (record.cwd) directory = record.cwd;
      }

      if (record.type === "message" && record.message) {
        const role = record.message.role;
        if (role === "user" || role === "assistant") messageCount++;
        if (role === "user") {
          const text = extractUserText(record.message.content);
          if (text) {
            if (!firstPrompt) firstPrompt = text.slice(0, 200);
            lastPrompt = text.slice(0, 200);
          }
        }
      }
    }

    if (!directory) {
      directory = decodeDirectoryName(path.basename(path.dirname(filePath)));
    }
    if (!sessionId) {
      const stem = path.basename(filePath, ".jsonl");
      sessionId = stem.includes("_") ? stem.split("_")[1] : stem;
    }
    if (!lastActivity) {
      lastActivity = fs.statSync(filePath).mtime.toISOString();
    }

    return {
      id: sessionId,
      directory,
      firstPrompt,
      lastPrompt,
      lastActivity,
      messageCount,
      isRunning: running.has(sessionId),
    };
  } catch {
    return null;
  }
}

function parseSessionMessages(filePath: string, limit: number): SessionMessage[] {
  const messages: SessionMessage[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let record: SessionRecord;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      if (record.type !== "message" || !record.message) continue;
      const role = record.message.role;

      if (role === "user") {
        const text = extractUserText(record.message.content);
        if (text) {
          messages.push({ role: "user", content: text, timestamp: record.timestamp ?? null });
        }
      } else if (role === "assistant") {
        const text = extractAssistantText(record.message.content);
        if (text) {
          messages.push({ role: "assistant", content: text, timestamp: record.timestamp ?? null });
        }
      }
    }
  } catch {
    // Return what we have
  }
  return messages.slice(-limit);
}

// ---------------------------------------------------------------------------
// Find latest session file for a project directory
// ---------------------------------------------------------------------------

function findLatestSessionFile(projectDir: string): string | null {
  const sessionsRoot = piSessionsDir();
  if (!fs.existsSync(sessionsRoot)) return null;

  // Try all subdirs, find ones whose decoded path matches or contains projectDir
  let bestFile: string | null = null;
  let bestMtime = 0;

  for (const entry of fs.readdirSync(sessionsRoot)) {
    const dirPath = path.join(sessionsRoot, entry);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const decoded = decodeDirectoryName(entry);
    // Match if the decoded path matches or starts with the project dir
    if (projectDir && decoded !== projectDir && !decoded.startsWith(projectDir)) {
      continue;
    }

    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith(".jsonl"))) {
      const fullPath = path.join(dirPath, file);
      const mtime = fs.statSync(fullPath).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestFile = fullPath;
      }
    }
  }

  return bestFile;
}

function findSessionFileById(sessionId: string): string | null {
  const sessionsRoot = piSessionsDir();
  if (!fs.existsSync(sessionsRoot)) return null;

  for (const entry of fs.readdirSync(sessionsRoot)) {
    const dirPath = path.join(sessionsRoot, entry);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith(".jsonl"))) {
      if (file.includes(sessionId)) {
        return path.join(dirPath, file);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const listSchema = Type.Object({
  directory: Type.Optional(Type.String({
    description: "Filter to sessions in this project directory (e.g., '/home/lars/xithing/pibot'). Omit to list all.",
  })),
  limit: Type.Optional(Type.Number({
    description: "Maximum sessions to return (default: 20).",
  })),
});

const readSchema = Type.Object({
  session_id: Type.Optional(Type.String({
    description: "Session UUID to read. Use pi_session_list to find IDs.",
  })),
  directory: Type.Optional(Type.String({
    description: "Read the most recent session in this project directory.",
  })),
  limit: Type.Optional(Type.Number({
    description: "Maximum messages to return (default: 30, from the end of the conversation).",
  })),
});

export function createPiSessionTools(): AgentTool<any>[] {
  const listTool: AgentTool<typeof listSchema> = {
    name: "pi_session_list",
    label: "pi_session_list",
    description:
      "List pi coding agent sessions on this machine. Shows project directory, " +
      "first and last prompt, activity time, and whether the session is running. " +
      "Use to see what work is happening across projects.",
    parameters: listSchema,
    async execute(
      _toolCallId: string,
      params: Static<typeof listSchema>,
    ): Promise<AgentToolResult<unknown>> {
      const sessionsRoot = piSessionsDir();
      if (!fs.existsSync(sessionsRoot)) {
        return toolError("No pi sessions directory found");
      }

      const running = findRunningPiSessionIds();
      const limit = params.limit ?? 20;
      const summaries: SessionSummary[] = [];

      for (const entry of fs.readdirSync(sessionsRoot)) {
        const dirPath = path.join(sessionsRoot, entry);
        if (!fs.statSync(dirPath).isDirectory()) continue;

        if (params.directory) {
          const decoded = decodeDirectoryName(entry);
          if (decoded !== params.directory && !decoded.startsWith(params.directory)) continue;
        }

        // Only parse the most recent session file per project
        const files = fs.readdirSync(dirPath)
          .filter(f => f.endsWith(".jsonl"))
          .sort()
          .reverse();

        if (files.length > 0) {
          const summary = parseSessionFile(path.join(dirPath, files[0]), running);
          if (summary) summaries.push(summary);
        }
      }

      summaries.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
      return toolSuccess({ sessions: summaries.slice(0, limit) });
    },
  };

  const readTool: AgentTool<typeof readSchema> = {
    name: "pi_session_read",
    label: "pi_session_read",
    description:
      "Read the conversation from a pi coding agent session. Returns recent " +
      "user and assistant messages (no tool calls). Use to understand what " +
      "another agent is working on or where it got stuck.",
    parameters: readSchema,
    async execute(
      _toolCallId: string,
      params: Static<typeof readSchema>,
    ): Promise<AgentToolResult<unknown>> {
      const limit = params.limit ?? 30;
      let filePath: string | null = null;

      if (params.session_id) {
        filePath = findSessionFileById(params.session_id);
      } else if (params.directory) {
        filePath = findLatestSessionFile(params.directory);
      } else {
        return toolError("Provide either session_id or directory");
      }

      if (!filePath) {
        return toolError("Session not found");
      }

      const messages = parseSessionMessages(filePath, limit);
      const running = findRunningPiSessionIds();

      // Extract session ID from filename
      const stem = path.basename(filePath, ".jsonl");
      const sessionId = stem.includes("_") ? stem.split("_")[1] : stem;

      return toolSuccess({
        session_id: sessionId,
        directory: decodeDirectoryName(path.basename(path.dirname(filePath))),
        is_running: running.has(sessionId),
        message_count: messages.length,
        messages,
      });
    },
  };

  return [listTool, readTool];
}
