/**
 * Pi session awareness tools.
 *
 * Gives bryti awareness of pi CLI sessions on disk. Bryti can see what
 * other agents are working on, check their progress, search conversations,
 * and inject messages into running or stopped sessions.
 *
 * Sessions live at ~/.pi/agent/sessions/<encoded-dir>/<timestamp>_<uuid>.jsonl
 * The encoded dir replaces / with - and wraps with --.
 *
 * Running detection uses three signals:
 * 1. bryti-bridge socket exists at ~/.pi/agent/sockets/<session-id>-<token>.sock
 * 2. A pi process has matching cwd (via /proc/<pid>/cwd)
 * 3. Session file was modified in the last 60 seconds
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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

/**
 * Map running pi processes to their working directories.
 * Uses /proc/<pid>/cwd since pi processes show as just "pi" in ps
 * with no session ID in the command line.
 */
function findRunningPiCwds(): Map<string, number> {
  const cwdToPid = new Map<string, number>();
  try {
    const ps = execSync("ps aux", { timeout: 5000, encoding: "utf-8" });
    for (const line of ps.split("\n")) {
      // Match lines where the command is exactly "pi" (end of line)
      // or contains "/pi " or "pi-coding-agent"
      const fields = line.trim().split(/\s+/);
      const cmd = fields.slice(10).join(" ");
      if (cmd !== "pi" && !cmd.endsWith("/pi") && !cmd.includes("/pi ") && !cmd.includes("pi-coding-agent")) continue;

      const pid = parseInt(fields[1], 10);
      if (isNaN(pid)) continue;

      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        cwdToPid.set(cwd, pid);
      } catch { /* process may have exited */ }
    }
  } catch { /* best effort */ }
  return cwdToPid;
}

/**
 * Check if a session is running using multiple signals:
 * 1. Bridge socket exists in ~/.pi/agent/sockets/
 * 2. A pi process has the matching cwd
 * 3. Session file was modified in the last 60 seconds
 */
function isSessionRunning(
  sessionId: string,
  directory: string,
  filePath: string,
  piCwds: Map<string, number>,
): boolean {
  // Signal 1: bridge socket exists
  if (findBridgeSocket(sessionId)) return true;

  // Signal 2: a pi process is running in the matching directory
  if (piCwds.has(directory)) return true;

  // Signal 3: file recently modified (active writing)
  try {
    const mtime = fs.statSync(filePath).mtimeMs;
    if (Date.now() - mtime < 60_000) return true;
  } catch { /* ignore */ }

  return false;
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
  isRunning: boolean;
}

interface SessionMessage {
  role: string;
  content: string;
  timestamp: string | null;
}

/**
 * Parse a session file for summary info. Optimized: reads the first few KB
 * for the session header and first prompt, then tails the file for the last
 * prompt and activity timestamp. Avoids reading multi-MB files fully.
 */
function parseSessionFile(filePath: string, piCwds: Map<string, number>): SessionSummary | null {
  try {
    const stat = fs.statSync(filePath);
    let sessionId: string | null = null;
    let directory: string | null = null;
    let firstPrompt: string | null = null;
    let lastPrompt: string | null = null;
    let lastActivity: string | null = null;

    // Read head (first 16KB) for session header + first user message
    const fd = fs.openSync(filePath, "r");
    try {
      const headBuf = Buffer.alloc(Math.min(16384, stat.size));
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      const headStr = headBuf.toString("utf-8");
      for (const line of headStr.split("\n")) {
        if (!line.trim()) continue;
        let record: SessionRecord;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.type === "session") {
          sessionId = record.id ?? null;
          if (record.cwd) directory = record.cwd;
        }
        if (record.type === "message" && record.message?.role === "user" && !firstPrompt) {
          const text = extractUserText(record.message.content);
          if (text) firstPrompt = text.slice(0, 200);
        }
        if (firstPrompt) break; // Got what we need from the head
      }

      // Read tail (last 16KB) for last user message + last timestamp
      const tailSize = Math.min(16384, stat.size);
      const tailBuf = Buffer.alloc(tailSize);
      fs.readSync(fd, tailBuf, 0, tailSize, Math.max(0, stat.size - tailSize));
      const tailStr = tailBuf.toString("utf-8");
      const tailLines = tailStr.split("\n").reverse();
      for (const line of tailLines) {
        if (!line.trim()) continue;
        let record: SessionRecord;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.timestamp && !lastActivity) lastActivity = record.timestamp;
        if (record.type === "message" && record.message?.role === "user" && !lastPrompt) {
          const text = extractUserText(record.message.content);
          if (text) lastPrompt = text.slice(0, 200);
        }
        if (lastActivity && lastPrompt) break;
      }
    } finally {
      fs.closeSync(fd);
    }

    if (!directory) {
      directory = decodeDirectoryName(path.basename(path.dirname(filePath)));
    }
    if (!sessionId) {
      const stem = path.basename(filePath, ".jsonl");
      sessionId = stem.includes("_") ? stem.split("_")[1] : stem;
    }
    if (!lastActivity) {
      lastActivity = stat.mtime.toISOString();
    }

    return {
      id: sessionId,
      directory,
      firstPrompt,
      lastPrompt,
      lastActivity,
      isRunning: isSessionRunning(sessionId, directory, filePath, piCwds),
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
// Socket bridge for running sessions
// ---------------------------------------------------------------------------

function bridgeSocketsDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "sockets");
}

/**
 * Find the bridge socket for a session by listing the sockets directory
 * and matching the session ID prefix. The filename includes a random token
 * for security: <session-id>-<token>.sock
 */
function findBridgeSocket(sessionId: string): string | null {
  const dir = bridgeSocketsDir();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(sessionId) && f.endsWith(".sock")) {
        return path.join(dir, f);
      }
    }
  } catch { /* directory doesn't exist */ }
  return null;
}

/**
 * Send a message to a running pi session via the bryti-bridge extension socket.
 * Returns null on success, or an error message on failure.
 */
function sendViaBridge(sessionId: string, text: string): Promise<string | null> {
  return new Promise((resolve) => {
    const sockPath = findBridgeSocket(sessionId);

    if (!sockPath) {
      resolve("Bridge socket not found. The pi session may not have the bryti-bridge extension installed.");
      return;
    }

    const conn = net.createConnection(sockPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      conn.destroy();
      resolve("Bridge connection timed out");
    }, 5000);

    conn.on("connect", () => {
      conn.write(JSON.stringify({ type: "user_message", text }) + "\n");
    });

    conn.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          clearTimeout(timeout);
          conn.end();
          if (resp.ok) {
            resolve(null);
          } else {
            resolve(resp.error || "Bridge returned error");
          }
        } catch {
          clearTimeout(timeout);
          conn.end();
          resolve("Invalid response from bridge");
        }
        return; // Only process first response
      }
    });

    conn.on("error", (err) => {
      clearTimeout(timeout);
      resolve(`Bridge connection failed: ${err.message}`);
    });
  });
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

      const piCwds = findRunningPiCwds();
      const limit = params.limit ?? 20;
      const summaries: SessionSummary[] = [];

      for (const entry of fs.readdirSync(sessionsRoot)) {
        const dirPath = path.join(sessionsRoot, entry);
        if (!fs.statSync(dirPath).isDirectory()) continue;

        if (params.directory) {
          const decoded = decodeDirectoryName(entry);
          if (decoded !== params.directory && !decoded.startsWith(params.directory)) continue;
        }

        const files = fs.readdirSync(dirPath)
          .filter(f => f.endsWith(".jsonl"))
          .sort()
          .reverse();

        if (params.directory) {
          // When filtering by directory, show all sessions (user wants detail)
          for (const file of files) {
            const summary = parseSessionFile(path.join(dirPath, file), piCwds);
            if (summary) summaries.push(summary);
          }
        } else {
          // Overview mode: only the most recent session per project
          if (files.length > 0) {
            const summary = parseSessionFile(path.join(dirPath, files[0]), piCwds);
            if (summary) summaries.push(summary);
          }
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
      const piCwds = findRunningPiCwds();

      // Extract session ID from filename
      const stem = path.basename(filePath, ".jsonl");
      const sessionId = stem.includes("_") ? stem.split("_")[1] : stem;
      const directory = decodeDirectoryName(path.basename(path.dirname(filePath)));

      return toolSuccess({
        session_id: sessionId,
        directory,
        is_running: isSessionRunning(sessionId, directory, filePath, piCwds),
        message_count: messages.length,
        messages,
      });
    },
  };

  const injectSchema = Type.Object({
    session_id: Type.Optional(Type.String({
      description: "Session UUID to inject into. Use pi_session_list to find IDs.",
    })),
    directory: Type.Optional(Type.String({
      description: "Inject into the most recent session in this project directory.",
    })),
    message: Type.String({
      description: "The message to inject as a user message into the session.",
    }),
  });

  const injectTool: AgentTool<typeof injectSchema> = {
    name: "pi_session_inject",
    label: "pi_session_inject",
    description:
      "Inject a user message into a pi coding agent session. For running sessions, " +
      "sends via the bryti-bridge extension (requires the extension to be installed). " +
      "For stopped sessions, appends to the session file so the message appears when " +
      "the session is resumed. Use to steer, leave instructions, or add context.",
    parameters: injectSchema,
    async execute(
      _toolCallId: string,
      params: Static<typeof injectSchema>,
    ): Promise<AgentToolResult<unknown>> {
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

      const piCwds = findRunningPiCwds();
      const stem = path.basename(filePath, ".jsonl");
      const sessionId = stem.includes("_") ? stem.split("_")[1] : stem;
      const directory = decodeDirectoryName(path.basename(path.dirname(filePath)));
      const isRunning = isSessionRunning(sessionId, directory, filePath, piCwds);

      // For running sessions, try the bryti-bridge socket
      if (isRunning) {
        const bridgeError = await sendViaBridge(sessionId, params.message);
        if (bridgeError === null) {
          return toolSuccess({
            injected: true,
            method: "bridge",
            session_id: sessionId,
            directory: decodeDirectoryName(path.basename(path.dirname(filePath))),
            message_preview: params.message.slice(0, 100),
          });
        }
        // Bridge failed; can't inject into running session without it
        return toolError(
          `Session is running but bridge injection failed: ${bridgeError}. ` +
          "Either install the bryti-bridge pi extension, wait for the session to stop, " +
          "or ask the user to relay the message.",
        );
      }

      // Stopped session: append to JSONL file directly.
      // Find the last entry's id to set as parentId
      let lastEntryId: string | null = null;
      try {
        const stat = fs.statSync(filePath);
        const tailSize = Math.min(8192, stat.size);
        const fd = fs.openSync(filePath, "r");
        try {
          const buf = Buffer.alloc(tailSize);
          fs.readSync(fd, buf, 0, tailSize, Math.max(0, stat.size - tailSize));
          const lines = buf.toString("utf-8").split("\n").reverse();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const record = JSON.parse(line);
              if (record.id) {
                lastEntryId = record.id;
                break;
              }
            } catch { continue; }
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return toolError("Failed to read session file");
      }

      if (!lastEntryId) {
        return toolError("Could not find last entry in session file");
      }

      // Generate a short hex id (matching pi's format)
      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      const now = new Date();

      const entry = {
        type: "message",
        id,
        parentId: lastEntryId,
        timestamp: now.toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: params.message }],
          timestamp: now.getTime(),
        },
      };

      try {
        // Check if file ends with newline (read last byte only)
        const fd = fs.openSync(filePath, "r");
        const stat = fs.fstatSync(fd);
        const lastByte = Buffer.alloc(1);
        fs.readSync(fd, lastByte, 0, 1, stat.size - 1);
        fs.closeSync(fd);
        const sep = lastByte[0] === 0x0a ? "" : "\n"; // 0x0a = '\n'
        fs.appendFileSync(filePath, sep + JSON.stringify(entry) + "\n", "utf-8");
      } catch {
        return toolError("Failed to write to session file");
      }

      return toolSuccess({
        injected: true,
        session_id: sessionId,
        directory: decodeDirectoryName(path.basename(path.dirname(filePath))),
        message_preview: params.message.slice(0, 100),
      });
    },
  };

  // --- Search tool ---

  const searchSchema = Type.Object({
    query: Type.String({
      description: "Search terms to find in session conversations. Matches against user and assistant messages.",
    }),
    directory: Type.Optional(Type.String({
      description: "Limit search to sessions in this project directory.",
    })),
    limit: Type.Optional(Type.Number({
      description: "Maximum results to return (default: 20).",
    })),
  });

  interface SearchHit {
    session_id: string;
    directory: string;
    is_running: boolean;
    role: string;
    content_snippet: string;
    timestamp: string | null;
  }

  const searchTool: AgentTool<typeof searchSchema> = {
    name: "pi_session_search",
    label: "pi_session_search",
    description:
      "Search across all pi coding agent session conversations for keywords. " +
      "Returns matching messages with context. Use to find where a topic was " +
      "discussed, what decisions were made, or locate a specific session.",
    parameters: searchSchema,
    async execute(
      _toolCallId: string,
      params: Static<typeof searchSchema>,
    ): Promise<AgentToolResult<unknown>> {
      const sessionsRoot = piSessionsDir();
      if (!fs.existsSync(sessionsRoot)) {
        return toolError("No pi sessions directory found");
      }

      const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) {
        return toolError("Provide at least one search term");
      }

      const piCwds = findRunningPiCwds();
      const maxResults = params.limit ?? 20;
      const hits: SearchHit[] = [];

      for (const entry of fs.readdirSync(sessionsRoot)) {
        if (hits.length >= maxResults) break;

        const dirPath = path.join(sessionsRoot, entry);
        if (!fs.statSync(dirPath).isDirectory()) continue;

        const directory = decodeDirectoryName(entry);
        if (params.directory && directory !== params.directory && !directory.startsWith(params.directory)) {
          continue;
        }

        // Search most recent session file per directory (avoid scanning old sessions)
        const files = fs.readdirSync(dirPath)
          .filter(f => f.endsWith(".jsonl"))
          .sort()
          .reverse()
          .slice(0, 3); // Check up to 3 most recent sessions per project

        for (const file of files) {
          if (hits.length >= maxResults) break;
          const filePath = path.join(dirPath, file);

          const stem = path.basename(file, ".jsonl");
          const sessionId = stem.includes("_") ? stem.split("_")[1] : stem;
          const running = isSessionRunning(sessionId, directory, filePath, piCwds);

          // Read the file and search line by line
          try {
            const raw = fs.readFileSync(filePath, "utf-8");
            for (const line of raw.split("\n")) {
              if (hits.length >= maxResults) break;
              if (!line.trim()) continue;

              let record: SessionRecord;
              try { record = JSON.parse(line); } catch { continue; }
              if (record.type !== "message" || !record.message) continue;

              const role = record.message.role;
              if (role !== "user" && role !== "assistant") continue;

              const text = role === "user"
                ? extractUserText(record.message.content)
                : extractAssistantText(record.message.content);
              if (!text) continue;

              const lower = text.toLowerCase();
              if (!terms.every(t => lower.includes(t))) continue;

              // Build a snippet around the first match
              const firstTermIdx = Math.min(...terms.map(t => {
                const idx = lower.indexOf(t);
                return idx >= 0 ? idx : Infinity;
              }));
              const snippetStart = Math.max(0, firstTermIdx - 80);
              const snippetEnd = Math.min(text.length, firstTermIdx + 200);
              const snippet = (snippetStart > 0 ? "..." : "") +
                text.slice(snippetStart, snippetEnd).trim() +
                (snippetEnd < text.length ? "..." : "");

              hits.push({
                session_id: sessionId,
                directory,
                is_running: running,
                role,
                content_snippet: snippet,
                timestamp: record.timestamp ?? null,
              });
            }
          } catch { /* skip unreadable files */ }
        }
      }

      if (hits.length === 0) {
        return toolSuccess({ message: "No matches found", query: params.query, results: [] });
      }

      return toolSuccess({
        query: params.query,
        result_count: hits.length,
        results: hits,
      });
    },
  };

  return [listTool, readTool, injectTool, searchTool];
}
