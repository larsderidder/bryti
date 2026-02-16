/**
 * Persistent memory system.
 *
 * File-based, using the same MEMORY.md pattern as pi.
 * Memory is loaded into the system prompt and updatable via tool.
 */

import fs from "node:fs";
import path from "node:path";

export interface MemoryManager {
  /** Read the full memory content. */
  read(): Promise<string>;

  /** Overwrite memory with new content. */
  update(content: string): Promise<void>;

  /** Path to the memory file. */
  readonly filePath: string;
}

/**
 * Create a file-based memory manager.
 */
export function createMemoryManager(dataDir: string): MemoryManager {
  const filePath = path.join(dataDir, "memory.md");

  // Ensure directory exists
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  return {
    filePath,

    async read(): Promise<string> {
      if (!fs.existsSync(filePath)) {
        return "";
      }
      return fs.readFileSync(filePath, "utf-8");
    },

    async update(content: string): Promise<void> {
      fs.writeFileSync(filePath, content, "utf-8");
    },
  };
}
