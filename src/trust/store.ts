/**
 * Trust levels and runtime permissions.
 *
 * Three capability levels: Safe (local data the agent owns), Guarded
 * (external content processed through worker isolation), and Elevated
 * (direct external access: network, shell, unreviewed extensions).
 *
 * Elevated tools require explicit user approval on first use. Approvals
 * are persisted to disk so they survive restarts.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Capability levels, ordered from least to most privileged.
 *
 * - `safe`: local data the agent owns outright (core memory, SQLite, session
 *   files). No user approval needed.
 * - `guarded`: external content that arrives through the worker isolation
 *   boundary. The worker runs in a separate session with scoped tools, so
 *   untrusted content never reaches the main agent directly. No explicit
 *   approval needed, but the boundary itself is the protection.
 * - `elevated`: direct external access without isolation — network requests,
 *   shell execution, unreviewed extension code. Requires explicit user approval
 *   before the tool may run.
 */
export type CapabilityLevel = "safe" | "guarded" | "elevated";

/**
 * Specific capabilities a tool may require. Used in permission prompts
 * to tell the user *what* the tool wants access to.
 */
export type Capability = "network" | "filesystem" | "shell";

/**
 * Tool capability declaration. Tools that need elevated access declare
 * their capabilities here.
 */
export interface ToolCapabilities {
  /** Overall trust level required */
  level: CapabilityLevel;
  /** Specific capabilities needed (for elevated tools) */
  capabilities?: Capability[];
  /** Human-readable reason shown in the permission prompt */
  reason?: string;
}

/**
 * Persistent approval record.
 */
interface ApprovalRecord {
  /** Tool name */
  tool: string;
  /** When the approval was granted */
  grantedAt: string;
  /** "always" or "once" */
  duration: "always" | "once";
}

// ---------------------------------------------------------------------------
// Trust store (file-backed)
// ---------------------------------------------------------------------------

export interface TrustStore {
  /** Check if a tool is approved for elevated access. */
  isApproved(toolName: string): boolean;

  /** Grant approval for a tool. "always" persists to disk; "once" is session-only. */
  approve(toolName: string, duration: "always" | "once"): void;

  /** Revoke approval for a tool. */
  revoke(toolName: string): void;

  /** List all approved tools. */
  listApproved(): Array<{ tool: string; duration: "always" | "once" }>;

  /** Consume a one-time approval (returns true if it existed). */
  consumeOnce(toolName: string): boolean;
}

/**
 * Create a trust store backed by a JSON file. Pre-approved tools from config
 * are always allowed; runtime approvals are stored in trust-approvals.json.
 */
export function createTrustStore(dataDir: string, preApproved: string[] = []): TrustStore {
  const filePath = path.join(dataDir, "trust-approvals.json");
  const preApprovedSet = new Set(preApproved);
  const onceApprovals = new Set<string>();

  function loadPersistedApprovals(): Map<string, ApprovalRecord> {
    if (!fs.existsSync(filePath)) return new Map();
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ApprovalRecord[];
      return new Map(data.map((r) => [r.tool, r]));
    } catch {
      return new Map();
    }
  }

  function savePersistedApprovals(approvals: Map<string, ApprovalRecord>): void {
    const data = [...approvals.values()];
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  return {
    isApproved(toolName: string): boolean {
      if (preApprovedSet.has(toolName)) return true;
      if (onceApprovals.has(toolName)) return true;
      const persisted = loadPersistedApprovals();
      return persisted.has(toolName);
    },

    approve(toolName: string, duration: "always" | "once"): void {
      if (duration === "once") {
        onceApprovals.add(toolName);
        return;
      }
      const persisted = loadPersistedApprovals();
      persisted.set(toolName, {
        tool: toolName,
        grantedAt: new Date().toISOString(),
        duration: "always",
      });
      savePersistedApprovals(persisted);
    },

    revoke(toolName: string): void {
      onceApprovals.delete(toolName);
      const persisted = loadPersistedApprovals();
      if (persisted.delete(toolName)) {
        savePersistedApprovals(persisted);
      }
    },

    listApproved(): Array<{ tool: string; duration: "always" | "once" }> {
      const result: Array<{ tool: string; duration: "always" | "once" }> = [];
      for (const tool of preApprovedSet) {
        result.push({ tool, duration: "always" });
      }
      for (const tool of onceApprovals) {
        if (!preApprovedSet.has(tool)) {
          result.push({ tool, duration: "once" });
        }
      }
      const persisted = loadPersistedApprovals();
      for (const [tool, record] of persisted) {
        if (!preApprovedSet.has(tool) && !onceApprovals.has(tool)) {
          result.push({ tool, duration: record.duration });
        }
      }
      return result;
    },

    consumeOnce(toolName: string): boolean {
      if (onceApprovals.has(toolName)) {
        onceApprovals.delete(toolName);
        return true;
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Capability registry
// ---------------------------------------------------------------------------

/** Map of tool name -> capabilities. Tools not in the registry are Safe. */
const toolCapabilityRegistry = new Map<string, ToolCapabilities>();

/**
 * Register a tool's capability requirements.
 */
export function registerToolCapabilities(toolName: string, capabilities: ToolCapabilities): void {
  toolCapabilityRegistry.set(toolName, capabilities);
}

/**
 * Get a tool's declared capabilities. Returns Safe if not registered.
 */
export function getToolCapabilities(toolName: string): ToolCapabilities {
  return toolCapabilityRegistry.get(toolName) ?? { level: "safe" };
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

export interface PermissionCheckResult {
  allowed: boolean;
  /** If not allowed, a message to show the user via the agent. */
  blockReason?: string;
}

/**
 * Check whether a tool call should be allowed. Safe and guarded tools always
 * pass; elevated tools require explicit user approval.
 */
export function checkPermission(
  toolName: string,
  trustStore: TrustStore,
): PermissionCheckResult {
  const caps = getToolCapabilities(toolName);

  if (caps.level === "safe" || caps.level === "guarded") {
    return { allowed: true };
  }

  // Elevated: check approval
  if (trustStore.isApproved(toolName)) {
    // Consume one-time approvals
    trustStore.consumeOnce(toolName);
    return { allowed: true };
  }

  const capList = caps.capabilities?.join(", ") ?? "elevated access";
  const reason = caps.reason ?? `This tool requires ${capList}.`;

  return {
    allowed: false,
    blockReason:
      `Permission required: "${toolName}" needs ${capList}. ${reason} ` +
      `Ask the user: "Can I use ${toolName}? It needs ${capList}." ` +
      `If they approve, I'll remember the permission.`,
  };
}

// ---------------------------------------------------------------------------
// Pending approval tracking
// ---------------------------------------------------------------------------

// File-backed approvals (trust-approvals.json) persist across restarts because
// they represent deliberate, considered user decisions: "always allow this tool".
// Pending approvals, by contrast, are transient per-session state: the agent
// asked for permission in this conversation, the user hasn't replied yet. There
// is no value in carrying that half-finished handshake across a restart, and
// doing so could surface stale permission prompts after an unrelated restart.
// The in-process Map is therefore intentional and correct for pending state.
/** Tools waiting for user approval. Set by the agent when a tool is blocked. */
const pendingApprovals = new Map<string, string>();

/**
 * Mark a tool as pending approval for `userId`.
 *
 * This is a text-based approval handshake for channels that don't support
 * inline buttons: the agent tells the user what it wants to do, sets a
 * pending entry here, and the next message from that user is tested against
 * an affirmative word list by checkPendingApproval().
 *
 * The key lives only in the in-process `pendingApprovals` Map. It is
 * intentionally not persisted to disk: if the process restarts between the
 * agent's request and the user's reply, the pending state is lost and the
 * user simply needs to ask again. This avoids stale approval prompts
 * surviving across restarts.
 */
export function setPendingApproval(userId: string, toolName: string): void {
  pendingApprovals.set(userId, toolName);
}

/**
 * Check whether the user's message completes a pending approval handshake.
 *
 * Returns the tool name that was approved if `userMessage` is an affirmative
 * word and there is a pending entry for `userId`; returns null if the message
 * is negative (clears the pending state), or if it is neither (leaves the
 * pending state intact so the conversation can continue).
 *
 * The affirmative and negative word lists are intentionally short to avoid
 * false positives: only unambiguous single-word replies are treated as
 * approval signals.
 */
export function checkPendingApproval(userId: string, userMessage: string): string | null {
  const toolName = pendingApprovals.get(userId);
  if (!toolName) return null;

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

  const negative = ["no", "n", "nope", "deny", "cancel", "nee"];
  if (negative.includes(lower)) {
    pendingApprovals.delete(userId);
    return null;
  }

  // Not a clear yes/no; leave the pending state but don't block conversation
  return null;
}

/**
 * Check whether the user's message is an "always approve" grant rather than
 * a one-time "yes".
 *
 * Only exact matches of "always" or "always allow" qualify. Phrases like
 * "yes always" or "sure always" do NOT match here; they fall through to the
 * normal affirmative check in checkPendingApproval() and result in a one-time
 * approval. This keeps the always-grant intentional and explicit.
 */
export function isAlwaysApproval(userMessage: string): boolean {
  const lower = userMessage.toLowerCase().trim();
  return lower === "always" || lower === "always allow";
}
