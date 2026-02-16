/**
 * Conversation history search.
 */

import fs from "node:fs";
import path from "node:path";

export interface ConversationSearchResult {
  content: string;
  role: "user" | "assistant";
  timestamp: string;
  /** Which day file this came from */
  date: string;
}

/**
 * Search conversation history for messages matching a query.
 */
export function searchConversations(
  historyDir: string,
  query: string,
  limit: number = 10,
): ConversationSearchResult[] {
  if (!query.trim()) {
    return [];
  }

  if (!fs.existsSync(historyDir)) {
    return [];
  }

  const files = fs
    .readdirSync(historyDir)
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .reverse();

  if (files.length === 0) {
    return [];
  }

  const needle = query.toLowerCase();
  const results: ConversationSearchResult[] = [];

  for (const file of files) {
    const filePath = path.join(historyDir, file);
    const date = path.basename(file, ".jsonl");
    const lines = fs.readFileSync(filePath, "utf-8").split("\n");

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let parsed: { content?: string; role?: "user" | "assistant"; timestamp?: string } | null = null;

      try {
        parsed = JSON.parse(line) as { content?: string; role?: "user" | "assistant"; timestamp?: string };
      } catch {
        continue;
      }

      if (!parsed.content || !parsed.role || !parsed.timestamp) {
        continue;
      }

      if (!parsed.content.toLowerCase().includes(needle)) {
        continue;
      }

      results.push({
        content: parsed.content,
        role: parsed.role,
        timestamp: parsed.timestamp,
        date,
      });

      if (results.length >= limit) {
        return results;
      }
    }
  }

  return results;
}
