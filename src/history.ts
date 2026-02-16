/**
 * Conversation history management.
 *
 * JSONL files rotated by day. Provides recent context for the agent.
 */

import fs from "node:fs";
import path from "node:path";

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
  timestamp: string;
}

export interface HistoryManager {
  /** Get recent messages for context, respecting token budget. */
  getRecent(maxMessages: number, maxTokens: number): Promise<ChatMessage[]>;

  /** Append a message to today's history file. */
  append(message: Omit<ChatMessage, "timestamp">): Promise<void>;

  /** Clear all history. */
  clear(): Promise<void>;
}

/**
 * Create a file-based history manager.
 */
export function createHistoryManager(dataDir: string): HistoryManager {
  const historyDir = path.join(dataDir, "history");

  // Ensure directory exists
  fs.mkdirSync(historyDir, { recursive: true });

  function getTodayFilename(): string {
    const today = new Date().toISOString().split("T")[0];
    return `${today}.jsonl`;
  }

  function getHistoryFilePath(filename: string): string {
    return path.join(historyDir, filename);
  }

  function listHistoryFiles(): string[] {
    if (!fs.existsSync(historyDir)) {
      return [];
    }
    return fs.readdirSync(historyDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse(); // Most recent first
  }

  return {
    async getRecent(maxMessages: number, maxTokens: number): Promise<ChatMessage[]> {
      const messages: ChatMessage[] = [];
      const files = listHistoryFiles();
      let totalChars = 0;

      for (const file of files) {
        if (messages.length >= maxMessages || totalChars >= maxTokens * 4) {
          break;
        }

        const filePath = getHistoryFilePath(file);
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.trim().split("\n").reverse(); // Reverse to read from most recent

        for (const line of lines) {
          if (!line.trim()) continue;
          if (messages.length >= maxMessages || totalChars >= maxTokens * 4) {
            break;
          }

          try {
            const msg = JSON.parse(line) as ChatMessage;
            const msgSize = JSON.stringify(msg).length;
            if (totalChars + msgSize <= maxTokens * 4) {
              messages.push(msg);
              totalChars += msgSize;
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      // Reverse to get chronological order
      return messages.reverse();
    },

    async append(message: Omit<ChatMessage, "timestamp">): Promise<void> {
      const fullMessage: ChatMessage = {
        ...message,
        timestamp: new Date().toISOString(),
      };
      const filePath = getHistoryFilePath(getTodayFilename());
      const line = JSON.stringify(fullMessage) + "\n";
      fs.appendFileSync(filePath, line, "utf-8");
    },

    async clear(): Promise<void> {
      const files = listHistoryFiles();
      for (const file of files) {
        fs.unlinkSync(getHistoryFilePath(file));
      }
    },
  };
}
