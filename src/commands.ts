/**
 * Slash command handling and activity logging.
 *
 * Handles /clear, /memory, /log, and /restart commands.
 * Builds the human-readable activity log from tool-calls.jsonl.
 */

import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "./channels/types.js";
import type { Config } from "./config.js";
import type { CoreMemory } from "./memory/core-memory.js";
import type { HistoryManager } from "./history.js";
import { getUserTimezone } from "./time.js";

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
  file_read: "Read a file",
  file_write: "Wrote a file",
  file_list: "Listed files",
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

export interface SlashCommandContext {
  config: Config;
  coreMemory: CoreMemory;
  historyManager: HistoryManager;
  /** Callback to dispose and delete a user session. */
  disposeSession: (userId: string) => void;
  /** Send a message to the user. */
  sendMessage: (channelId: string, text: string) => Promise<string>;
  /** Trigger a restart. */
  triggerRestart: (msg: IncomingMessage, reason: string) => Promise<void>;
}

/**
 * Check if the incoming message is a slash command and handle it.
 * Returns true if the message was a command (and was handled), false otherwise.
 */
export async function handleSlashCommand(
  msg: IncomingMessage,
  context: SlashCommandContext,
): Promise<boolean> {
  if (msg.text === "/clear") {
    // Clear the JSONL audit log and dispose the in-memory session so the next
    // message starts fresh (a new session file will be created).
    await context.historyManager.clear();
    context.disposeSession(msg.userId);
    await context.sendMessage(msg.channelId, "Conversation history cleared.");
    return true;
  }

  if (msg.text === "/memory") {
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

  if (msg.text === "/log") {
    const logText = buildActivityLog(
      context.config.data_dir,
      msg.userId,
      getUserTimezone(context.config),
    );
    await context.sendMessage(msg.channelId, logText);
    return true;
  }

  if (msg.text === "/restart") {
    await context.triggerRestart(msg, "user command");
    return true;
  }

  return false;
}
