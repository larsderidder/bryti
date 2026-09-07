import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type CapabilityLevel = "safe" | "guarded" | "elevated";
export type Capability = "network" | "filesystem" | "shell";
export type ApprovalDuration = "always" | "once";
export type ApprovalKind = "tool" | "invocation";

export interface ToolCapabilities {
  level: CapabilityLevel;
  capabilities?: Capability[];
  reason?: string;
}

export interface ApprovalProvenance {
  userId?: string;
  threadId?: string;
  platform?: string;
  channelId?: string;
  automationId?: string;
  channelThreadId?: string;
  source?: string;
}

export interface ApprovalRecord {
  id: string;
  kind: ApprovalKind;
  tool: string;
  grantedAt: string;
  duration: ApprovalDuration;
  argsHash?: string;
  argsSummary?: string;
  expiresAt?: string;
  provenance?: ApprovalProvenance;
}

export interface ListedApproval {
  id?: string;
  kind?: ApprovalKind;
  tool: string;
  duration: ApprovalDuration;
  grantedAt?: string;
  argsHash?: string;
  argsSummary?: string;
  expiresAt?: string;
  provenance?: ApprovalProvenance;
}

export interface TrustStore {
  isApproved(toolName: string): boolean;
  hasToolApproval(toolName: string): boolean;
  approve(toolName: string, duration: ApprovalDuration, provenance?: ApprovalProvenance, expiresAt?: string): ApprovalRecord;
  revoke(toolName: string): void;
  listApproved(): ListedApproval[];
  consumeOnce(toolName: string): boolean;
  approveInvocation(
    toolName: string,
    args: unknown,
    duration: ApprovalDuration,
    provenance?: ApprovalProvenance,
    expiresAt?: string,
  ): ApprovalRecord;
  isInvocationApproved(toolName: string, args: unknown, provenance?: ApprovalProvenance): boolean;
  consumeInvocationOnce(toolName: string, args: unknown, provenance?: ApprovalProvenance): boolean;
  revokeGrant(grantId: string): boolean;
}

const toolCapabilityRegistry = new Map<string, ToolCapabilities>();
const pendingApprovals = new Map<string, string>();
const REDACTED = "[redacted]";
const SUMMARY_LIMIT = 1_000;
const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|bearer|client[_-]?secret|credential|password|private[_-]?key|secret|token)/i;
const TOKEN_VALUE_PATTERN = /\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9._-]{10,}\b|\b(?:sk|pk|ghp|gho|ghu|github_pat)_[A-Za-z0-9_]{16,}\b/;

function truncateText(text: string, maxChars = SUMMARY_LIMIT): string {
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}... [truncated, ${omitted} chars omitted]`;
}

function stableValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) {
    return "[undefined]";
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return "[NaN]";
    }
    if (!Number.isFinite(value)) {
      return value.toString();
    }
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const items = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return items;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const objectValue = value as Record<string, unknown>;
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(objectValue).sort()) {
      result[key] = stableValue(objectValue[key], seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

function sanitizeUrlText(text: string): string {
  try {
    const url = new URL(text);
    if (url.username) {
      url.username = REDACTED;
    }
    if (url.password) {
      url.password = REDACTED;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY_PATTERN.test(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return text;
  }
}

function sanitizeString(text: string): string {
  const urlSafe = sanitizeUrlText(text);
  if (TOKEN_VALUE_PATTERN.test(urlSafe)) {
    return REDACTED;
  }
  return urlSafe;
}

function sanitizedValue(value: unknown, seen: WeakSet<object>, keyName?: string): unknown {
  if (keyName && SECRET_KEY_PATTERN.test(keyName)) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const items = value.map((item) => sanitizedValue(item, seen));
    seen.delete(value);
    return items;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const objectValue = value as Record<string, unknown>;
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(objectValue).sort()) {
      result[key] = sanitizedValue(objectValue[key], seen, key);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

export function canonicalizeToolArgs(args: unknown): string {
  return JSON.stringify(stableValue(args, new WeakSet<object>()));
}

export function hashToolArgs(args: unknown): string {
  return crypto.createHash("sha256").update(canonicalizeToolArgs(args)).digest("hex");
}

export function summarizeToolArgs(args: unknown, maxChars = SUMMARY_LIMIT): string {
  const sanitized = sanitizedValue(args, new WeakSet<object>());
  return truncateText(JSON.stringify(sanitized), maxChars);
}

export function extractToolDestination(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  const candidateKeys = ["url", "uri", "href", "endpoint", "host", "hostname", "path", "file", "filename", "command"];
  for (const key of candidateKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncateText(sanitizeString(value), 300);
    }
  }
  return undefined;
}

function makeGrantId(toolName: string, kind: ApprovalKind, argsHash?: string): string {
  const hashPart = argsHash ? argsHash.slice(0, 16) : crypto.randomBytes(8).toString("hex");
  return `${kind}:${toolName}:${hashPart}:${crypto.randomUUID()}`;
}

function isRecordValid(record: ApprovalRecord): boolean {
  if (!record.expiresAt) {
    return true;
  }
  return Date.parse(record.expiresAt) > Date.now();
}

const PROVENANCE_KEYS = [
  "userId",
  "threadId",
  "platform",
  "channelId",
  "channelThreadId",
  "automationId",
  "source",
] as const;

function normalizeProvenance(provenance?: ApprovalProvenance): ApprovalProvenance | undefined {
  if (!provenance) {
    return undefined;
  }
  const result: ApprovalProvenance = {};
  for (const key of PROVENANCE_KEYS) {
    const value = provenance[key];
    if (value) {
      result[key] = value;
    }
  }
  if (Object.keys(result).length === 0) {
    return undefined;
  }
  return result;
}

function matchesProvenance(record: ApprovalRecord, provenance?: ApprovalProvenance): boolean {
  const stored = record.provenance;
  const current = normalizeProvenance(provenance);
  if (!stored) {
    return !current;
  }
  for (const key of PROVENANCE_KEYS) {
    if (stored[key] && stored[key] !== current?.[key]) {
      return false;
    }
  }
  return true;
}

function normalizeRecord(raw: unknown): ApprovalRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const tool = value.tool;
  const duration = value.duration;
  if (typeof tool !== "string") {
    return null;
  }
  if (duration !== "always" && duration !== "once") {
    return null;
  }
  const kind = value.kind === "invocation" ? "invocation" : "tool";
  const argsHash = typeof value.argsHash === "string" ? value.argsHash : undefined;
  if (kind === "invocation" && !argsHash) {
    return null;
  }
  let provenance: ApprovalProvenance | undefined;
  if (value.provenance && typeof value.provenance === "object") {
    provenance = normalizeProvenance(value.provenance as ApprovalProvenance);
  }
  return {
    id: typeof value.id === "string" ? value.id : makeGrantId(tool, kind, argsHash),
    kind,
    tool,
    grantedAt: typeof value.grantedAt === "string" ? value.grantedAt : new Date().toISOString(),
    duration,
    argsHash,
    argsSummary: typeof value.argsSummary === "string" ? value.argsSummary : undefined,
    expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : undefined,
    provenance,
  };
}

function invocationKey(toolName: string, args: unknown, provenance?: ApprovalProvenance): string {
  const scope = normalizeProvenance(provenance);
  return [
    toolName,
    hashToolArgs(args),
    scope?.userId ?? "",
    scope?.threadId ?? "",
    scope?.platform ?? "",
    scope?.channelId ?? "",
    scope?.channelThreadId ?? "",
    scope?.automationId ?? "",
    scope?.source ?? "",
  ].join("\u0000");
}

export function createTrustStore(dataDir: string, preApproved: string[] = []): TrustStore {
  const filePath = path.join(dataDir, "trust-approvals.json");
  const preApprovedSet = new Set(preApproved);
  const onceToolApprovals = new Map<string, ApprovalRecord>();
  const onceInvocationApprovals = new Map<string, ApprovalRecord>();

  function loadPersistedApprovals(): Map<string, ApprovalRecord> {
    if (!fs.existsSync(filePath)) {
      return new Map();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
      if (!Array.isArray(parsed)) {
        return new Map();
      }
      const result = new Map<string, ApprovalRecord>();
      let changed = false;
      for (const raw of parsed) {
        const record = normalizeRecord(raw);
        if (!record) {
          changed = true;
          continue;
        }
        if (!isRecordValid(record)) {
          changed = true;
          continue;
        }
        result.set(record.id, record);
      }
      if (changed) {
        savePersistedApprovals(result);
      }
      return result;
    } catch {
      return new Map();
    }
  }

  function savePersistedApprovals(approvals: Map<string, ApprovalRecord>): void {
    fs.mkdirSync(dataDir, { recursive: true });
    const data = [...approvals.values()]
      .filter((record) => record.duration === "always")
      .filter(isRecordValid)
      .sort((left, right) => left.grantedAt.localeCompare(right.grantedAt));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  function findToolRecord(toolName: string): ApprovalRecord | undefined {
    const once = onceToolApprovals.get(toolName);
    if (once && isRecordValid(once)) {
      return once;
    }
    if (once) {
      onceToolApprovals.delete(toolName);
    }
    for (const record of loadPersistedApprovals().values()) {
      if (record.kind === "tool" && record.tool === toolName && isRecordValid(record)) {
        return record;
      }
    }
    return undefined;
  }

  function findInvocationRecord(toolName: string, args: unknown, provenance?: ApprovalProvenance): ApprovalRecord | undefined {
    const key = invocationKey(toolName, args, provenance);
    const once = onceInvocationApprovals.get(key);
    if (once && isRecordValid(once) && matchesProvenance(once, provenance)) {
      return once;
    }
    if (once) {
      onceInvocationApprovals.delete(key);
    }
    const argsHash = hashToolArgs(args);
    for (const record of loadPersistedApprovals().values()) {
      if (record.kind !== "invocation") {
        continue;
      }
      if (record.tool !== toolName || record.argsHash !== argsHash) {
        continue;
      }
      if (!matchesProvenance(record, provenance)) {
        continue;
      }
      if (isRecordValid(record)) {
        return record;
      }
    }
    return undefined;
  }

  return {
    isApproved(toolName: string): boolean {
      return this.hasToolApproval(toolName);
    },

    hasToolApproval(toolName: string): boolean {
      if (preApprovedSet.has(toolName)) {
        return true;
      }
      return Boolean(findToolRecord(toolName));
    },

    approve(toolName: string, duration: ApprovalDuration, provenance?: ApprovalProvenance, expiresAt?: string): ApprovalRecord {
      const record: ApprovalRecord = {
        id: makeGrantId(toolName, "tool"),
        kind: "tool",
        tool: toolName,
        grantedAt: new Date().toISOString(),
        duration,
        expiresAt,
        provenance: normalizeProvenance(provenance),
      };
      if (duration === "once") {
        onceToolApprovals.set(toolName, record);
        return record;
      }
      const persisted = loadPersistedApprovals();
      persisted.set(record.id, record);
      savePersistedApprovals(persisted);
      return record;
    },

    revoke(toolName: string): void {
      onceToolApprovals.delete(toolName);
      for (const [key, record] of onceInvocationApprovals) {
        if (record.tool === toolName) {
          onceInvocationApprovals.delete(key);
        }
      }
      const persisted = loadPersistedApprovals();
      let changed = false;
      for (const [id, record] of persisted) {
        if (record.tool === toolName) {
          persisted.delete(id);
          changed = true;
        }
      }
      if (changed) {
        savePersistedApprovals(persisted);
      }
    },

    listApproved(): ListedApproval[] {
      const result: ListedApproval[] = [];
      for (const tool of preApprovedSet) {
        result.push({ tool, duration: "always", kind: "tool", provenance: { source: "config" } });
      }
      for (const record of onceToolApprovals.values()) {
        if (isRecordValid(record) && !preApprovedSet.has(record.tool)) {
          result.push(record);
        }
      }
      for (const record of onceInvocationApprovals.values()) {
        if (isRecordValid(record)) {
          result.push(record);
        }
      }
      for (const record of loadPersistedApprovals().values()) {
        if (preApprovedSet.has(record.tool) && record.kind === "tool") {
          continue;
        }
        result.push(record);
      }
      return result;
    },

    consumeOnce(toolName: string): boolean {
      const record = onceToolApprovals.get(toolName);
      if (!record || !isRecordValid(record)) {
        onceToolApprovals.delete(toolName);
        return false;
      }
      onceToolApprovals.delete(toolName);
      return true;
    },

    approveInvocation(
      toolName: string,
      args: unknown,
      duration: ApprovalDuration,
      provenance?: ApprovalProvenance,
      expiresAt?: string,
    ): ApprovalRecord {
      const argsHash = hashToolArgs(args);
      const record: ApprovalRecord = {
        id: makeGrantId(toolName, "invocation", argsHash),
        kind: "invocation",
        tool: toolName,
        grantedAt: new Date().toISOString(),
        duration,
        argsHash,
        argsSummary: summarizeToolArgs(args),
        expiresAt,
        provenance: normalizeProvenance(provenance),
      };
      if (duration === "once") {
        onceInvocationApprovals.set(invocationKey(toolName, args, provenance), record);
        return record;
      }
      const persisted = loadPersistedApprovals();
      persisted.set(record.id, record);
      savePersistedApprovals(persisted);
      return record;
    },

    isInvocationApproved(toolName: string, args: unknown, provenance?: ApprovalProvenance): boolean {
      return Boolean(findInvocationRecord(toolName, args, provenance));
    },

    consumeInvocationOnce(toolName: string, args: unknown, provenance?: ApprovalProvenance): boolean {
      const key = invocationKey(toolName, args, provenance);
      const record = onceInvocationApprovals.get(key);
      if (record && isRecordValid(record) && matchesProvenance(record, provenance)) {
        onceInvocationApprovals.delete(key);
        return true;
      }
      if (record) {
        onceInvocationApprovals.delete(key);
      }

      const argsHash = hashToolArgs(args);
      for (const [storedKey, storedRecord] of onceInvocationApprovals) {
        if (storedRecord.tool !== toolName || storedRecord.argsHash !== argsHash) {
          continue;
        }
        if (!isRecordValid(storedRecord) || !matchesProvenance(storedRecord, provenance)) {
          if (!isRecordValid(storedRecord)) {
            onceInvocationApprovals.delete(storedKey);
          }
          continue;
        }
        onceInvocationApprovals.delete(storedKey);
        return true;
      }
      return false;
    },

    revokeGrant(grantId: string): boolean {
      let revoked = false;
      for (const [key, record] of onceToolApprovals) {
        if (record.id === grantId) {
          onceToolApprovals.delete(key);
          revoked = true;
        }
      }
      for (const [key, record] of onceInvocationApprovals) {
        if (record.id === grantId) {
          onceInvocationApprovals.delete(key);
          revoked = true;
        }
      }
      const persisted = loadPersistedApprovals();
      if (persisted.delete(grantId)) {
        savePersistedApprovals(persisted);
        revoked = true;
      }
      return revoked;
    },
  };
}

export function registerToolCapabilities(toolName: string, capabilities: ToolCapabilities): void {
  toolCapabilityRegistry.set(toolName, capabilities);
}

export function getToolCapabilities(toolName: string): ToolCapabilities {
  return toolCapabilityRegistry.get(toolName) ?? { level: "safe" };
}

export interface PermissionCheckResult {
  allowed: boolean;
  blockReason?: string;
}

export function checkPermission(
  toolName: string,
  trustStore: TrustStore,
): PermissionCheckResult {
  const caps = getToolCapabilities(toolName);

  if (caps.level === "safe" || caps.level === "guarded") {
    return { allowed: true };
  }

  if (trustStore.hasToolApproval(toolName)) {
    trustStore.consumeOnce(toolName);
    return { allowed: true };
  }

  const capList = caps.capabilities?.join(", ") ?? "elevated access";
  const reason = caps.reason ?? `This tool requires ${capList}.`;

  return {
    allowed: false,
    blockReason:
      `Permission required: "${toolName}" needs ${capList}. ${reason} ` +
      `Ask the user to approve the actual operation and arguments before running it.`,
  };
}

export function setPendingApproval(userId: string, toolName: string): void {
  pendingApprovals.set(userId, toolName);
}

export function checkPendingApproval(userId: string, userMessage: string): string | null {
  const toolName = pendingApprovals.get(userId);
  if (!toolName) {
    return null;
  }

  const lower = userMessage.toLowerCase().trim();
  const affirmative = [
    "yes", "y", "yep", "yeah", "sure", "ok", "okay", "allow",
    "allow it", "go ahead", "do it", "approved", "ja", "oke",
    "always", "always allow",
  ];

  if (affirmative.includes(lower)) {
    pendingApprovals.delete(userId);
    return toolName;
  }

  const negative = ["no", "n", "nope", "deny", "cancel", "stop", "nee"];
  if (negative.includes(lower)) {
    pendingApprovals.delete(userId);
    return null;
  }

  return null;
}

export function isAlwaysApproval(userMessage: string): boolean {
  const lower = userMessage.toLowerCase().trim();
  return lower === "always" || lower === "always allow";
}
