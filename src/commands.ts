/**
 * Slash command handling and activity logging.
 *
 * Handles /clear, /memory, /log, /restart, /trust, and thread commands.
 * Builds the human-readable activity log from tool-calls.jsonl.
 */

import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, SendOpts } from "./channels/types.js";
import type { Config } from "./config.js";
import type { CoreMemory } from "./memory/core-memory.js";
import type { HistoryManager } from "./history.js";
import { getUserTimezone } from "./time.js";
import { createThread, getActiveThread, listThreads, switchThread } from "./threads.js";
import type { ListedApproval, TrustStore } from "./trust/index.js";
import type { WorkStore } from "./work/store.js";

/**
 * Human-readable labels for the /log output. Tool names never leak to the user.
 */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  memory_archival_search: "Searched memory",
  memory_archival_insert: "Saved a memory",
  memory_core_append: "Updated core memory",
  memory_core_replace: "Updated core memory",
  memory_conversation_search: "Searched conversation history",
  projection_create: "Set a reminder",
  projection_resolve: "Resolved a reminder",
  projection_list: "Checked upcoming reminders",
  projection_link: "Linked memory to a reminder",
  worker_dispatch: "Started background research",
  worker_check: "Checked background task",
  worker_interrupt: "Cancelled a background task",
  worker_steer: "Adjusted a background task",
  read: "Read a file",
  file_write: "Wrote a file",
  ls: "Listed directory",
};

interface ToolCallLogEntry {
  timestamp: string;
  userId: string;
  toolName: string;
  args_summary: string;
}

/**
 * Build a human-readable activity summary from the tool call log.
 */
export function buildActivityLog(dataDir: string, userId: string, timezone: string): string {
  const logPath = path.join(dataDir, "logs", "tool-calls.jsonl");

  if (!fs.existsSync(logPath)) {
    return "No recent activity on record yet.";
  }

  let entries: ToolCallLogEntry[];
  try {
    const raw = fs.readFileSync(logPath, "utf-8");
    entries = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as ToolCallLogEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is ToolCallLogEntry => entry !== null);
  } catch {
    return "Could not read the activity log.";
  }

  // Filter to this user, take the last 20 entries
  const userEntries = entries
    .filter((e) => e.userId === userId)
    .slice(-20);

  if (userEntries.length === 0) {
    return "No recent activity on record yet.";
  }

  const lines = userEntries.map((entry) => {
    const ts = new Date(entry.timestamp);
    const time = ts.toLocaleString("sv-SE", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const description = TOOL_DESCRIPTIONS[entry.toolName] ?? "Ran a task";
    const detail = entry.args_summary ? `: ${entry.args_summary}` : "";
    return `- ${time}  ${description}${detail}`;
  });

  return `Recent activity:\n${lines.join("\n")}`;
}

function formatTrustScope(record: ListedApproval): string {
  const scope = record.provenance;
  if (!scope) {
    return "unknown scope";
  }
  const parts: string[] = [];
  if (scope.userId) {
    parts.push(`user ${scope.userId}`);
  }
  if (scope.source) {
    parts.push(`source ${scope.source}`);
  }
  if (scope.platform) {
    parts.push(`platform ${scope.platform}`);
  }
  if (scope.channelId) {
    parts.push(`channel ${scope.channelId}`);
  }
  if (scope.channelThreadId) {
    parts.push(`topic ${scope.channelThreadId}`);
  }
  if (scope.threadId) {
    parts.push(`thread ${scope.threadId}`);
  }
  if (scope.automationId) {
    parts.push(`automation ${scope.automationId}`);
  }
  if (parts.length === 0) {
    return "unknown scope";
  }
  return parts.join(", ");
}

function formatTrustGrant(record: ListedApproval): string {
  const id = record.id ?? "config";
  const kind = record.kind ?? "tool";
  const details = [`${kind}`, record.duration];
  if (record.expiresAt) {
    details.push(`expires ${record.expiresAt}`);
  }
  details.push(formatTrustScope(record));

  const lines = [`- ${id} ${record.tool} (${details.join(", ")})`];
  if (record.argsSummary) {
    lines.push(`  args: ${record.argsSummary}`);
  }
  return lines.join("\n");
}

function formatTrustList(trustStore: TrustStore, userId: string): string {
  const grants = trustStore.listApproved().filter((grant) => {
    return grant.provenance?.userId === userId || (!grant.provenance?.userId && grant.kind !== "invocation");
  });
  if (grants.length === 0) {
    return "No trust approvals on record.";
  }
  return [
    "Trust approvals:",
    ...grants.map(formatTrustGrant),
    "",
    "Use /trust revoke <grant id> to revoke a stored grant. Config approvals show as config and must be removed from config.yml.",
  ].join("\n");
}

export interface SlashCommandContext {
  config: Config;
  coreMemory: CoreMemory;
  historyManager: HistoryManager;
  /** Store for listing and revoking trust grants. */
  trustStore?: TrustStore;
  workStore?: WorkStore;
  /** Callback to dispose and delete a user session. */
  disposeSession: (userId: string, threadId?: string) => void;
  /** Send a message to the user. */
  sendMessage: (channelId: string, text: string, opts?: SendOpts) => Promise<string>;
  /** Trigger a restart. */
  triggerRestart: (msg: IncomingMessage, reason: string) => Promise<void>;
}

function parseSlashCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const [head, ...rest] = trimmed.split(/\s+/);
  const command = head.slice(1).split("@", 1)[0];
  if (!command) return null;
  return { command, args: rest.join(" ") };
}

/**
 * Check if the incoming message is a slash command and handle it.
 * Returns true if the message was a command (and was handled), false otherwise.
 */
export async function handleSlashCommand(
  msg: IncomingMessage,
  context: SlashCommandContext,
): Promise<boolean> {
  const parsed = parseSlashCommand(msg.text);
  if (!parsed) return false;

  if (parsed.command === "work") {
    let records = context.workStore?.listUnresolved(msg.userId) ?? [];
    if (parsed.args) {
      const record = context.workStore?.get(parsed.args);
      records = [];
      if (record?.message.userId === msg.userId) {
        records.push(record);
      }
    }
    const lines = records.slice(0, 20).map((record) => {
      return `${record.id}: execution=${record.execution}, delivery=${record.delivery}\n${record.message.text.slice(0, 120)}`;
    });
    let text = "No matching unresolved work receipts.";
    if (lines.length > 0) {
      text = `Work receipts, uncertain actions are not automatically repeated:\n\n${lines.join("\n\n")}`;
    }
    await context.sendMessage(msg.channelId, text);
    return true;
  }
  if (parsed.command === "threads") {
    const threads = listThreads(context.config.data_dir, msg.userId);
    const lines = threads.map((thread) => `${thread.active ? "*" : "-"} ${thread.title}`);
    await context.sendMessage(msg.channelId, `Threads:\n${lines.join("\n")}`);
    return true;
  }

  if (parsed.command === "new") {
    try {
      const thread = createThread(context.config.data_dir, msg.userId, parsed.args);
      await context.sendMessage(msg.channelId, `Created and switched to thread: ${thread.title}`);
    } catch (err) {
      await context.sendMessage(msg.channelId, (err as Error).message);
    }
    return true;
  }

  if (parsed.command === "switch") {
    const thread = switchThread(context.config.data_dir, msg.userId, parsed.args);
    if (!thread) {
      await context.sendMessage(msg.channelId, "I couldn't find that thread. Use /threads to see available threads.");
      return true;
    }
    await context.sendMessage(msg.channelId, `Switched to thread: ${thread.title}`);
    return true;
  }

  if (parsed.command === "clear") {
    // Dispose and delete only the active thread session. Shared memory,
    // reminders, and the activity log are retained.
    const threadId = getActiveThread(context.config.data_dir, msg.userId);
    context.disposeSession(msg.userId, threadId);
    await context.sendMessage(msg.channelId, "Current thread history cleared.");
    return true;
  }

  if (parsed.command === "memory") {
    const memory = context.coreMemory.read();
    if (memory) {
      await context.sendMessage(msg.channelId, `Your core memory:\n\n${memory}`);
    } else {
      await context.sendMessage(
        msg.channelId,
        "Your core memory is empty. I haven't saved anything yet.",
      );
    }
    return true;
  }

  if (parsed.command === "log") {
    const logText = buildActivityLog(
      context.config.data_dir,
      msg.userId,
      getUserTimezone(context.config),
    );
    await context.sendMessage(msg.channelId, logText);
    return true;
  }
  if (parsed.command === "trust") {
    if (!context.trustStore) {
      await context.sendMessage(msg.channelId, "Trust approvals are unavailable in this process.");
      return true;
    }

    const [subcommand, ...args] = parsed.args.trim().split(/\s+/).filter(Boolean);
    if (!subcommand || subcommand === "list") {
      await context.sendMessage(msg.channelId, formatTrustList(context.trustStore, msg.userId));
      return true;
    }

    if (subcommand === "revoke") {
      const grantId = args.join(" ").trim();
      if (!grantId) {
        await context.sendMessage(msg.channelId, "Usage: /trust revoke <grant id>");
        return true;
      }
      const grant = context.trustStore.listApproved().find((record) => record.id === grantId);
      if (grant?.provenance?.userId === msg.userId && context.trustStore.revokeGrant(grantId)) {
        await context.sendMessage(msg.channelId, `Revoked trust grant ${grantId}.`);
      } else {
        await context.sendMessage(
          msg.channelId,
          "No trust grant found for that id. Config approvals show as config and must be removed from config.yml.",
        );
      }
      return true;
    }

    await context.sendMessage(msg.channelId, "Usage: /trust, /trust list, or /trust revoke <grant id>");
    return true;
  }

  if (parsed.command === "restart") {
    await context.triggerRestart(msg, "user command");
    return true;
  }

  return false;
}
