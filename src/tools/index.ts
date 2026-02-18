/**
 * Tool registry.
 *
 * Pibot-specific tools registered as pi SDK custom tools.
 * These supplement pi's built-in tools (read/write/edit/bash).
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createWebSearchTool } from "./web-search.js";
import { createFetchUrlTool } from "./fetch-url.js";
import { createFileTools } from "./files.js";
import { createCoreMemoryTools } from "./core-memory-tool.js";
import { createArchivalMemoryTools } from "./archival-memory-tool.js";
import { createConversationSearchTool } from "./conversation-search-tool.js";
import { createScheduleTools } from "./schedule.js";
import { embed } from "../memory/embeddings.js";
import { createMemoryStore } from "../memory/store.js";
import path from "node:path";
import type { Config } from "../config.js";
import type { CoreMemory } from "../memory/core-memory.js";
import type { Scheduler } from "../scheduler.js";

export { createWebSearchTool };
export { createFetchUrlTool };
export { createFileTools };
export { createCoreMemoryTools };
export { createArchivalMemoryTools };
export { createConversationSearchTool };
export { createScheduleTools };

/**
 * Type for pibot tools (AgentTool from pi).
 */
export type PibotTool = AgentTool<any>;

/**
 * Create all pibot tools based on configuration.
 *
 * @param scheduler  Optional Scheduler instance. When provided, the three
 *                   schedule management tools (create/list/delete) are included.
 */
export function createTools(
  config: Config,
  coreMemory: CoreMemory,
  userId: string,
  scheduler?: Scheduler,
): PibotTool[] {
  const tools: PibotTool[] = [];

  // Web search tool
  if (config.tools.web_search.enabled && config.tools.web_search.api_key) {
    tools.push(createWebSearchTool(config.tools.web_search.api_key));
  }

  // Fetch URL tool
  if (config.tools.fetch_url.enabled) {
    tools.push(createFetchUrlTool(config.tools.fetch_url.timeout_ms));
  }

  // File tools
  if (config.tools.files.enabled) {
    tools.push(...createFileTools(config.tools.files.base_dir));
  }

  // Memory tools
  tools.push(...createCoreMemoryTools(coreMemory));

  // Archival memory: always available, uses local embeddings (no API key needed)
  const modelsDir = path.join(config.data_dir, ".models");
  const archivalStore = createMemoryStore(userId, config.data_dir);
  tools.push(
    ...createArchivalMemoryTools(archivalStore, (text) => embed(text, modelsDir)),
  );

  tools.push(createConversationSearchTool(path.join(config.data_dir, "history")));

  // Schedule tools: let the agent create/list/delete recurring tasks
  if (scheduler) {
    // For Telegram private chats, channelId equals userId (numeric string)
    tools.push(...createScheduleTools(scheduler, userId, userId));
  }

  return tools;
}
