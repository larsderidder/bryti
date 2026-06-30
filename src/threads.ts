import fs from "node:fs";
import path from "node:path";

export const DEFAULT_THREAD_ID = "main";

interface ThreadRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ThreadState {
  active: string;
  threads: ThreadRecord[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  active: boolean;
}

function userThreadsPath(dataDir: string, userId: string): string {
  return path.join(dataDir, "users", userId, "threads.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultState(): ThreadState {
  const now = nowIso();
  return {
    active: DEFAULT_THREAD_ID,
    threads: [{ id: DEFAULT_THREAD_ID, title: "main", createdAt: now, updatedAt: now }],
  };
}

function normalizeState(value: unknown): ThreadState {
  if (!value || typeof value !== "object") return defaultState();
  const candidate = value as Partial<ThreadState>;
  const threads = Array.isArray(candidate.threads) ? candidate.threads : [];
  const cleaned = threads
    .filter((t): t is ThreadRecord => {
      if (!t || typeof t !== "object") return false;
      const record = t as Partial<ThreadRecord>;
      return typeof record.id === "string" && typeof record.title === "string";
    })
    .map((t) => ({
      id: t.id,
      title: t.title,
      createdAt: t.createdAt || nowIso(),
      updatedAt: t.updatedAt || t.createdAt || nowIso(),
    }));

  if (!cleaned.some((t) => t.id === DEFAULT_THREAD_ID)) {
    cleaned.unshift(defaultState().threads[0]);
  }

  const active =
    typeof candidate.active === "string" && cleaned.some((t) => t.id === candidate.active)
      ? candidate.active
      : DEFAULT_THREAD_ID;

  return { active, threads: cleaned };
}

function readThreadState(dataDir: string, userId: string): ThreadState {
  const filePath = userThreadsPath(dataDir, userId);
  if (!fs.existsSync(filePath)) return defaultState();

  try {
    return normalizeState(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return defaultState();
  }
}

function writeThreadState(dataDir: string, userId: string, state: ThreadState): void {
  const filePath = userThreadsPath(dataDir, userId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function slugThreadName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function getActiveThread(dataDir: string, userId: string): string {
  return readThreadState(dataDir, userId).active;
}

export function getSessionKey(userId: string, threadId: string): string {
  const safeThreadId = slugThreadName(threadId) || DEFAULT_THREAD_ID;
  return safeThreadId === DEFAULT_THREAD_ID ? userId : `${userId}__thread__${safeThreadId}`;
}

export function createThread(dataDir: string, userId: string, title: string): ThreadSummary {
  const id = slugThreadName(title);
  if (!id) {
    throw new Error("Thread name must contain at least one letter or number.");
  }

  const state = readThreadState(dataDir, userId);
  const existing = state.threads.find((t) => t.id === id);
  const now = nowIso();
  if (existing) {
    state.active = existing.id;
    existing.updatedAt = now;
  } else {
    state.threads.push({ id, title: title.trim().slice(0, 80), createdAt: now, updatedAt: now });
    state.active = id;
  }
  writeThreadState(dataDir, userId, state);
  return { id, title: existing?.title ?? title.trim().slice(0, 80), active: true };
}

export function switchThread(dataDir: string, userId: string, name: string): ThreadSummary | null {
  const id = slugThreadName(name);
  const state = readThreadState(dataDir, userId);
  const thread = state.threads.find((t) => t.id === id || t.title.toLowerCase() === name.trim().toLowerCase());
  if (!thread) return null;
  state.active = thread.id;
  thread.updatedAt = nowIso();
  writeThreadState(dataDir, userId, state);
  return { id: thread.id, title: thread.title, active: true };
}

export function listThreads(dataDir: string, userId: string): ThreadSummary[] {
  const state = readThreadState(dataDir, userId);
  return state.threads.map((thread) => ({
    id: thread.id,
    title: thread.title,
    active: thread.id === state.active,
  }));
}
