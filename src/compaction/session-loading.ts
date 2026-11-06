import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  SessionManager, convertToLlm, serializeConversation, type SessionEntry, type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { writeTextAtomic } from "../durable-file.js";
import { boundSummary } from "./bounded.js";
import type { UserSession } from "../agent.js";
import { isSessionTurnReserved, isProactiveCompactionRunning } from "./proactive.js";

export const MAX_SESSION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
const RECENT_EXCERPT_CHARS = 48000;

/** Read a bounded header without asking the SDK to hydrate the transcript. */
function readHeader(file: string): SessionHeader | undefined {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(65536);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytes);
    const newline = text.indexOf("\n");
    let line = text;
    if (newline >= 0) {
      line = text.slice(0, newline);
    }
    const header = JSON.parse(line);
    if (header.type === "session" && typeof header.id === "string" && typeof header.cwd === "string") {
      return header;
    }
  } catch {
    // Non-session artifacts must not become the current conversation.
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

/** Scan append-only history with bounded line and retained-excerpt memory. */
function continuity(file: string): { summary: string; excerpts: string } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const before = fs.fstatSync(fd);
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.alloc(65536);
  let pending = "";
  let skippingLine = false;
  let summary = "";
  let recent: string[] = [];
  let recentChars = 0;
  let lastId: string | undefined;
  const visit = (line: string) => {
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!entry || typeof entry.id !== "string") {
      return;
    }
    if (lastId && entry.parentId !== lastId) {
      // A branch switch invalidates continuity from the previously scanned branch.
      summary = "";
      recent = [];
      recentChars = 0;
    }
    lastId = entry.id;
    if (entry.type === "compaction") {
      summary = boundSummary(entry.summary);
      recent = [];
      recentChars = 0;
    } else if (entry.type === "message" && entry.message.role !== "system") {
      const text = serializeConversation(convertToLlm([entry.message]));
      const excerpt = text.slice(0, 4000);
      recent.push(excerpt);
      recentChars += excerpt.length + 2;
      while (recentChars > RECENT_EXCERPT_CHARS && recent.length > 0) {
        recentChars -= recent.shift()!.length + 2;
      }
    }
  };
  try {
    let bytes: number;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      const text = decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      let end: number;
      while ((end = text.indexOf("\n", start)) >= 0) {
        const piece = text.slice(start, end);
        if (!skippingLine && pending.length + piece.length <= MAX_LINE_CHARS) {
          visit(pending + piece);
        }
        pending = "";
        skippingLine = false;
        start = end + 1;
      }
      if (!skippingLine) {
        pending += text.slice(start);
        if (pending.length > MAX_LINE_CHARS) {
          pending = "";
          skippingLine = true;
          // Do not carry a potentially different branch across an unreadable entry.
          summary = "";
          recent = [];
          recentChars = 0;
          lastId = undefined;
        }
      }
    }
    if (!skippingLine) {
      visit(pending + decoder.end());
    }
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Session changed during bounded loading; no successor was published");
    }
  } finally {
    fs.closeSync(fd);
  }
  return { summary, excerpts: recent.join("\n\n") };
}

/** Keep archives immutable and load a small, explicitly lossy successor before SDK hydration. */
export function openBoundedSession(
  cwd: string,
  sessionDir: string,
  maxBytes = MAX_SESSION_FILE_BYTES,
): SessionManager {
  const candidates = fs.readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => ({ file: path.join(sessionDir, entry.name), modified: fs.statSync(path.join(sessionDir, entry.name)).mtimeMs }))
    .sort((left, right) => right.modified - left.modified || right.file.localeCompare(left.file));
  for (const candidate of candidates) {
    const header = readHeader(candidate.file);
    if (!header || path.resolve(header.cwd) !== path.resolve(cwd)) {
      continue;
    }
    if (fs.statSync(candidate.file).size <= maxBytes) {
      return SessionManager.open(candidate.file, sessionDir, cwd);
    }
    const retained = continuity(candidate.file);
    const successor = SessionManager.create(cwd, sessionDir, { parentSession: candidate.file });
    successor.appendCompaction(retained.summary || "Older context omitted. Consult the archived conversation when needed.", null, 0,
      { bryti: { version: 1, degraded: true, reason: "rollover", sourceSessionId: header.id, archive: candidate.file } }, true);
    successor.appendCustomMessageEntry("bryti-session-continuity",
      "Historical excerpts from an archived conversation, not a new request. Older context was omitted. " +
      "Do not resume old tasks or repeat tool calls from these excerpts. Unknown effects, approvals and scheduling holds remain unchanged; " +
      "inspect durable receipts and approved operational guidelines before acting. Full archive: " + candidate.file +
      "\n\n" + retained.excerpts, false);
    const nextHeader = successor.getHeader()!;
    const name = `${nextHeader.timestamp.replace(/[:.]/g, "-")}_${nextHeader.id}.jsonl`;
    const file = path.join(sessionDir, name);
    writeTextAtomic(file, [nextHeader, ...successor.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    console.log("[compaction] Created bounded session successor; original archive retained");
    return SessionManager.open(file, sessionDir, cwd);
  }
  return SessionManager.create(cwd, sessionDir);
}

/** Evict idle sessions under cache pressure without interrupting turns or maintenance. */
export async function trimSessionCache(
  sessions: Map<string, UserSession>, protectedKey: string,
  options: { maxSessions?: number; isBusy?: () => boolean } = {},
): Promise<void> {
  let limit = options.maxSessions ?? 8;
  if (!sessions.has(protectedKey)) {
    limit -= 1;
  }
  const candidates = [...sessions.entries()].sort((left, right) => left[1].lastUserMessageAt - right[1].lastUserMessageAt);
  for (const [key, candidate] of candidates) {
    if (sessions.size <= limit || options.isBusy?.()) {
      break;
    }
    if (key === protectedKey || candidate.session.isStreaming || candidate.session.isCompacting ||
        isSessionTurnReserved(candidate) || isProactiveCompactionRunning(candidate)) {
      continue;
    }
    sessions.delete(key);
    await candidate.dispose();
  }
}
