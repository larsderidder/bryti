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
 * 1. pi-bridge socket exists at ~/.pi/agent/sockets/<session-id>-<token>.sock
 * 2. A pi process has matching cwd (via /proc/<pid>/cwd)
 * 3. Session file was modified in the last 60 seconds
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { toolError, toolSuccess } from "./result.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function piSessionsDir(): string {
  return process.env.PI_SESSIONS_DIR
    ?? path.join(process.env.HOME ?? "", ".pi", "agent", "sessions");
}

function piSessionsIndexPath(): string {
  return process.env.PI_SESSIONS_INDEX_PATH
    ?? path.join(process.env.HOME ?? "", ".pi", "agent", "pi-sessions", "index.sqlite");
}

interface PiSessionsIndex {
  db: Database.Database;
  path: string;
  schemaVersion: number;
  sessionCount: number;
}

function openPiSessionsIndex(): PiSessionsIndex | null {
  const indexPath = piSessionsIndexPath();
  if (!fs.existsSync(indexPath)) return null;
  try {
    const db = new Database(indexPath, { readonly: true, fileMustExist: true });
    const schemaVersionRow = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    const schemaVersion = Number(schemaVersionRow?.value);
    if (schemaVersion !== 12) {
      db.close();
      return null;
    }
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count?: number } | undefined;
    return { db, path: indexPath, schemaVersion, sessionCount: countRow?.count ?? 0 };
  } catch {
    return null;
  }
}

function indexInfo(index: PiSessionsIndex): Record<string, unknown> {
  return {
    path: index.path,
    schema_version: index.schemaVersion,
    session_count: index.sessionCount,
  };
}

function sqlDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function parseRepoRoots(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function sessionRowToResult(row: Record<string, any>, piCwds: Map<string, number>, snippet?: string): Record<string, unknown> {
  const sessionPath = String(row.sessionPath ?? row.session_path ?? "");
  const sessionId = String(row.sessionId ?? row.session_id ?? "");
  const cwd = String(row.cwd ?? "");
  const bridge = readBridgeMetadata(sessionId);
  return {
    session_id: sessionId,
    title: row.sessionName ?? row.session_name ?? undefined,
    session_path: sessionPath || undefined,
    directory: cwd,
    repo_roots: parseRepoRoots(row.repoRootsJson ?? row.repo_roots_json),
    started_at: row.startedAt ?? row.created_ts ?? undefined,
    modified_at: row.modifiedAt ?? row.modified_ts ?? undefined,
    message_count: row.messageCount ?? row.message_count ?? undefined,
    is_running: sessionPath ? isSessionRunning(sessionId, cwd, sessionPath, piCwds) : piCwds.has(cwd),
    parent_session_id: row.parentSessionId ?? row.parent_session_id ?? undefined,
    session_origin: row.sessionOrigin ?? row.session_origin ?? undefined,
    handoff_goal: row.handoffGoal ?? row.handoff_goal ?? undefined,
    handoff_next_task: row.handoffNextTask ?? row.handoff_next_task ?? undefined,
    first_prompt: row.firstUserPrompt ?? row.first_user_prompt ?? undefined,
    ...(bridge ? { bridge } : {}),
    ...(snippet ? { snippet } : {}),
  };
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

function readSessionRecords(filePath: string): SessionRecord[] {
  const records: SessionRecord[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as SessionRecord);
      } catch {
        // Skip malformed lines.
      }
    }
  } catch {
    // Return what we have.
  }
  return records;
}

function messageFromRecord(record: SessionRecord): SessionMessage | null {
  if (record.type !== "message" || !record.message) return null;
  const role = record.message.role;
  if (role === "user") {
    const text = extractUserText(record.message.content);
    return text ? { role: "user", content: text, timestamp: record.timestamp ?? null } : null;
  }
  if (role === "assistant") {
    const text = extractAssistantText(record.message.content);
    return text ? { role: "assistant", content: text, timestamp: record.timestamp ?? null } : null;
  }
  return null;
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

      const message = messageFromRecord(record);
      if (message) messages.push(message);
    }
  } catch {
    // Return what we have
  }
  return messages.slice(-limit);
}

function parseSessionBranchMessages(filePath: string, limit: number): SessionMessage[] {
  const records = readSessionRecords(filePath);
  const byId = new Map<string, SessionRecord>();
  let activeId: string | null = null;
  for (const record of records) {
    if (record.id) {
      byId.set(record.id, record);
      activeId = record.id;
    }
  }

  const activePath = new Set<string>();
  while (activeId) {
    const record = byId.get(activeId);
    if (!record) break;
    activePath.add(activeId);
    activeId = record.parentId ?? null;
  }

  const messages: SessionMessage[] = [];
  for (const record of records) {
    if (!record.id || !activePath.has(record.id)) continue;
    const message = messageFromRecord(record);
    if (message) messages.push(message);
  }
  return messages.slice(-limit);
}

function renderSessionTree(filePath: string, limit: number): string {
  const records = readSessionRecords(filePath);
  const children = new Map<string | null, SessionRecord[]>();
  let activeId: string | null = null;
  for (const record of records) {
    const parent = record.parentId ?? null;
    const list = children.get(parent) ?? [];
    list.push(record);
    children.set(parent, list);
    if (record.id) activeId = record.id;
  }

  const activePath = new Set<string>();
  let cursor = activeId;
  const byId = new Map(records.filter((record) => record.id).map((record) => [record.id!, record]));
  while (cursor) {
    const record = byId.get(cursor);
    if (!record) break;
    activePath.add(cursor);
    cursor = record.parentId ?? null;
  }

  const lines: string[] = [];
  const visit = (record: SessionRecord, depth: number): void => {
    if (lines.length >= limit) return;
    const marker = record.id && activePath.has(record.id) ? "*" : "-";
    const message = messageFromRecord(record);
    const label = message
      ? `${message.role}: ${message.content.replace(/\s+/g, " ").slice(0, 160)}`
      : record.type;
    lines.push(`${"  ".repeat(depth)}${marker} ${label}${record.id ? ` (${record.id})` : ""}`);
    for (const child of children.get(record.id ?? null) ?? []) {
      visit(child, depth + 1);
    }
  };

  for (const root of children.get(null) ?? []) {
    visit(root, 0);
  }
  return lines.join("\n");
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
  const index = openPiSessionsIndex();
  if (index) {
    try {
      const row = index.db.prepare(
        "SELECT session_path AS sessionPath FROM sessions WHERE session_id = ? LIMIT 1",
      ).get(sessionId) as { sessionPath?: string } | undefined;
      index.db.close();
      if (row?.sessionPath && fs.existsSync(row.sessionPath)) return row.sessionPath;
    } catch {
      try { index.db.close(); } catch { /* ignore */ }
    }
  }

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

function listSessionsFromIndex(params: { directory?: string; limit: number }): Record<string, unknown> | null {
  const index = openPiSessionsIndex();
  if (!index) return null;
  try {
    const piCwds = findRunningPiCwds();
    const where: string[] = [];
    const values: unknown[] = [];
    if (params.directory) {
      where.push("(cwd = ? OR cwd LIKE ?)");
      values.push(params.directory, `${params.directory}/%`);
    }
    const rows = index.db.prepare(`
      SELECT
        session_id AS sessionId,
        session_name AS sessionName,
        session_path AS sessionPath,
        cwd,
        repo_roots_json AS repoRootsJson,
        created_ts AS startedAt,
        modified_ts AS modifiedAt,
        message_count AS messageCount,
        parent_session_id AS parentSessionId,
        first_user_prompt AS firstUserPrompt,
        session_origin AS sessionOrigin,
        handoff_goal AS handoffGoal,
        handoff_next_task AS handoffNextTask
      FROM sessions
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY modified_ts DESC
      LIMIT ?
    `).all(...values, params.limit) as Record<string, any>[];

    return {
      source: "pi_sessions_index",
      index: indexInfo(index),
      sessions: rows.map((row) => sessionRowToResult(row, piCwds)),
    };
  } catch {
    return null;
  } finally {
    index.db.close();
  }
}

function searchSessionsFromIndex(params: {
  query?: string;
  directory?: string;
  cwd?: string;
  repo?: string;
  files?: { touched?: string[]; changed?: string[] };
  time?: { after?: string; before?: string };
  limit: number;
  sort?: string;
}): Record<string, unknown> | null {
  const index = openPiSessionsIndex();
  if (!index) return null;
  try {
    const piCwds = findRunningPiCwds();
    const where: string[] = [];
    const values: unknown[] = [];
    const cwd = params.cwd ?? params.directory;
    if (cwd) {
      where.push("(s.cwd = ? OR s.cwd LIKE ?)");
      values.push(cwd, `${cwd}/%`);
    }
    if (params.repo) {
      where.push("EXISTS (SELECT 1 FROM session_repo_roots r WHERE r.session_id = s.session_id AND (r.repo_root = ? OR r.repo_basename = ?))");
      values.push(params.repo, path.basename(params.repo));
    }
    const touched = [...(params.files?.touched ?? []), ...(params.files?.changed ?? [])];
    if (touched.length > 0) {
      const placeholders = touched.map(() => "?").join(", ");
      where.push(`EXISTS (SELECT 1 FROM session_file_touches f WHERE f.session_id = s.session_id AND (f.raw_path IN (${placeholders}) OR f.abs_path IN (${placeholders}) OR f.cwd_rel_path IN (${placeholders}) OR f.repo_rel_path IN (${placeholders}) OR f.basename IN (${placeholders})))`);
      values.push(...touched, ...touched, ...touched, ...touched, ...touched.map((file) => path.basename(file)));
    }
    const after = sqlDate(params.time?.after);
    if (after !== undefined) {
      where.push("s.modified_ts >= ?");
      values.push(new Date(after).toISOString());
    }
    const before = sqlDate(params.time?.before);
    if (before !== undefined) {
      where.push("s.modified_ts <= ?");
      values.push(new Date(before).toISOString());
    }

    if (params.query?.trim()) {
      const query = params.query.trim().replace(/"/g, "");
      const rows = index.db.prepare(`
        SELECT
          s.session_id AS sessionId,
          s.session_name AS sessionName,
          s.session_path AS sessionPath,
          s.cwd,
          s.repo_roots_json AS repoRootsJson,
          s.created_ts AS startedAt,
          s.modified_ts AS modifiedAt,
          s.message_count AS messageCount,
          s.parent_session_id AS parentSessionId,
          s.first_user_prompt AS firstUserPrompt,
          s.session_origin AS sessionOrigin,
          s.handoff_goal AS handoffGoal,
          s.handoff_next_task AS handoffNextTask,
          snippet(session_text_chunks_fts, 0, '[', ']', '...', 16) AS snippet
        FROM session_text_chunks_fts
        JOIN session_text_chunks c ON c.id = session_text_chunks_fts.rowid
        JOIN sessions s ON s.session_id = c.session_id
        ${where.length ? `WHERE session_text_chunks_fts MATCH ? AND ${where.join(" AND ")}` : "WHERE session_text_chunks_fts MATCH ?"}
        ORDER BY bm25(session_text_chunks_fts) ASC, s.modified_ts DESC
        LIMIT ?
      `).all(query, ...values, params.limit) as Record<string, any>[];
      return {
        source: "pi_sessions_index",
        index: indexInfo(index),
        query: params.query,
        result_count: rows.length,
        results: rows.map((row) => sessionRowToResult(row, piCwds, row.snippet)),
      };
    }

    const sort = params.sort === "modified_asc" ? "ASC" : "DESC";
    const rows = index.db.prepare(`
      SELECT
        s.session_id AS sessionId,
        s.session_name AS sessionName,
        s.session_path AS sessionPath,
        s.cwd,
        s.repo_roots_json AS repoRootsJson,
        s.created_ts AS startedAt,
        s.modified_ts AS modifiedAt,
        s.message_count AS messageCount,
        s.parent_session_id AS parentSessionId,
        s.first_user_prompt AS firstUserPrompt,
        s.session_origin AS sessionOrigin,
        s.handoff_goal AS handoffGoal,
        s.handoff_next_task AS handoffNextTask
      FROM sessions s
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.modified_ts ${sort}
      LIMIT ?
    `).all(...values, params.limit) as Record<string, any>[];
    return {
      source: "pi_sessions_index",
      index: indexInfo(index),
      result_count: rows.length,
      results: rows.map((row) => sessionRowToResult(row, piCwds)),
    };
  } catch {
    return null;
  } finally {
    index.db.close();
  }
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
      if (f.startsWith(`${sessionId}-`) && f.endsWith(".sock")) {
        return path.join(dir, f);
      }
    }
  } catch { /* directory doesn't exist */ }
  return null;
}

function readBridgeMetadata(sessionId: string): Record<string, unknown> | null {
  const sockPath = findBridgeSocket(sessionId);
  if (!sockPath) return null;
  const metadataPath = `${sockPath}.json`;
  try {
    return JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Send a message to a running pi session via the pi-bridge extension socket.
 * Returns null on success, or an error message on failure.
 */
function bridgeRequest(
  sessionId: string,
  request: Record<string, unknown>,
): Promise<{ ok: true; response: Record<string, unknown> } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const sockPath = findBridgeSocket(sessionId);

    if (!sockPath) {
      resolve({ ok: false, error: "Bridge socket not found. The pi session may not have the pi-bridge extension installed." });
      return;
    }

    const conn = net.createConnection(sockPath);
    let buffer = "";
    const timeout = setTimeout(() => {
      conn.destroy();
      resolve({ ok: false, error: "Bridge connection timed out" });
    }, 5000);

    conn.on("connect", () => {
      conn.write(JSON.stringify(request) + "\n");
    });

    conn.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line) as Record<string, unknown>;
          clearTimeout(timeout);
          conn.end();
          if (resp.ok) {
            resolve({ ok: true, response: resp });
          } else {
            resolve({ ok: false, error: String(resp.error || "Bridge returned error") });
          }
        } catch {
          clearTimeout(timeout);
          conn.end();
          resolve({ ok: false, error: "Invalid response from bridge" });
        }
        return;
      }
    });

    conn.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: `Bridge connection failed: ${err.message}` });
    });
  });
}

async function sendViaBridge(sessionId: string, text: string): Promise<string | null> {
  const metadata = readBridgeMetadata(sessionId);
  const capabilities = Array.isArray(metadata?.capabilities) ? metadata.capabilities : [];
  if (capabilities.includes("inject_user_message")) {
    const result = await bridgeRequest(sessionId, {
      id: crypto.randomUUID(),
      method: "inject_user_message",
      params: { text },
    });
    if (result.ok) return null;
    const legacy = await bridgeRequest(sessionId, { type: "user_message", text });
    return legacy.ok ? null : result.error;
  }

  const legacy = await bridgeRequest(sessionId, { type: "user_message", text });
  return legacy.ok ? null : legacy.error;
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
  mode: Type.Optional(Type.Union([
    Type.Literal("recent"),
    Type.Literal("active_branch"),
    Type.Literal("full_tree"),
  ], {
    description: "Read mode. recent is linear and backward compatible. active_branch follows parent links. full_tree renders a compact branch tree.",
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
      const limit = params.limit ?? 20;
      const indexed = listSessionsFromIndex({ directory: params.directory, limit });
      if (indexed) return toolSuccess(indexed);

      const sessionsRoot = piSessionsDir();
      if (!fs.existsSync(sessionsRoot)) {
        return toolError("No pi sessions directory found");
      }

      const piCwds = findRunningPiCwds();
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

      const mode = params.mode ?? "recent";
      const messages = mode === "active_branch"
        ? parseSessionBranchMessages(filePath, limit)
        : mode === "recent"
          ? parseSessionMessages(filePath, limit)
          : [];
      const treeMarkdown = mode === "full_tree" ? renderSessionTree(filePath, limit) : undefined;
      const piCwds = findRunningPiCwds();

      // Extract session ID from filename
      const stem = path.basename(filePath, ".jsonl");
      const sessionId = stem.includes("_") ? stem.split("_")[1] : stem;
      const directory = decodeDirectoryName(path.basename(path.dirname(filePath)));

      return toolSuccess({
        session_id: sessionId,
        directory,
        session_path: filePath,
        is_running: isSessionRunning(sessionId, directory, filePath, piCwds),
        mode,
        message_count: messages.length,
        ...(mode === "full_tree" ? { tree_markdown: treeMarkdown } : { messages }),
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
      "sends via the pi-bridge extension (requires the extension to be installed). " +
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
          "Either install the pi-bridge pi extension, wait for the session to stop, " +
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
    query: Type.Optional(Type.String({
      description: "Search terms to find in session conversations. Matches against user and assistant messages.",
    })),
    directory: Type.Optional(Type.String({
      description: "Limit search to sessions in this project directory. Alias for cwd.",
    })),
    cwd: Type.Optional(Type.String({
      description: "Limit search to sessions in this working directory.",
    })),
    repo: Type.Optional(Type.String({
      description: "Limit search to sessions touching this repo root or repo basename. Uses the pi-sessions index when available.",
    })),
    files: Type.Optional(Type.Object({
      touched: Type.Optional(Type.Array(Type.String())),
      changed: Type.Optional(Type.Array(Type.String())),
    })),
    time: Type.Optional(Type.Object({
      after: Type.Optional(Type.String()),
      before: Type.Optional(Type.String()),
    })),
    sort: Type.Optional(Type.Union([
      Type.Literal("relevance"),
      Type.Literal("modified_desc"),
      Type.Literal("modified_asc"),
    ])),
    limit: Type.Optional(Type.Number({
      description: "Maximum results to return (default: 20).",
    })),
    max_sessions_per_project: Type.Optional(Type.Number({
      description: "Maximum session files to search per project directory (default: all). Set lower to speed up broad searches.",
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
      const maxResults = params.limit ?? 20;
      const indexed = searchSessionsFromIndex({
        query: params.query,
        directory: params.directory,
        cwd: params.cwd,
        repo: params.repo,
        files: params.files,
        time: params.time,
        sort: params.sort,
        limit: maxResults,
      });
      if (indexed) return toolSuccess(indexed);

      const sessionsRoot = piSessionsDir();
      if (!fs.existsSync(sessionsRoot)) {
        return toolError("No pi sessions directory found");
      }

      if (params.repo || params.files || params.time || params.cwd) {
        return toolSuccess({
          source: "jsonl_fallback",
          degraded_filters: [
            ...(params.repo ? ["repo"] : []),
            ...(params.files ? ["files"] : []),
            ...(params.time ? ["time"] : []),
            ...(params.cwd ? ["cwd"] : []),
          ],
          message: "The pi-sessions index is unavailable, so advanced filters could not be applied.",
          results: [],
        });
      }

      const query = params.query ?? "";
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) {
        return toolError("Provide at least one search term");
      }

      const piCwds = findRunningPiCwds();
      const hits: SearchHit[] = [];

      for (const entry of fs.readdirSync(sessionsRoot)) {
        if (hits.length >= maxResults) break;

        const dirPath = path.join(sessionsRoot, entry);
        if (!fs.statSync(dirPath).isDirectory()) continue;

        const directory = decodeDirectoryName(entry);
        if (params.directory && directory !== params.directory && !directory.startsWith(params.directory)) {
          continue;
        }

        // Search session files, most recent first
        let files = fs.readdirSync(dirPath)
          .filter(f => f.endsWith(".jsonl"))
          .sort()
          .reverse();
        if (params.max_sessions_per_project) {
          files = files.slice(0, params.max_sessions_per_project);
        }

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
        return toolSuccess({ source: "jsonl_fallback", message: "No matches found", query, results: [] });
      }

      return toolSuccess({
        source: "jsonl_fallback",
        query,
        result_count: hits.length,
        results: hits,
      });
    },
  };

  return [listTool, readTool, injectTool, searchTool];
}
