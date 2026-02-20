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
import { createProjectionTools, createProjectionStore } from "../projection/index.js";
import { createWorkerTools, createWorkerRegistry } from "../workers/index.js";
import { embed } from "../memory/embeddings.js";
import { createMemoryStore } from "../memory/store.js";
import path from "node:path";
import type { Config } from "../config.js";
import type { CoreMemory } from "../memory/core-memory.js";


export { createWebSearchTool };
export { createFetchUrlTool };
export { createFileTools };
export { createCoreMemoryTools };
export { createArchivalMemoryTools };
export { createConversationSearchTool };
export { createProjectionTools, createProjectionStore };
export { createWorkerTools, createWorkerRegistry };

/**
 * Type for pibot tools (AgentTool from pi).
 */
export type PibotTool = AgentTool<any>;

/**
 * Create all pibot tools based on configuration.
 */
export function createTools(
  config: Config,
  coreMemory: CoreMemory,
  userId: string,
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

  // Projection memory: forward-looking events and commitments.
  // Created before archival tools so we can pass it in for trigger checking.
  const projectionStore = createProjectionStore(userId, config.data_dir);
  tools.push(...createProjectionTools(projectionStore, config.agent.timezone));

  // Archival memory: always available, uses local embeddings (no API key needed).
  // Receives the projection store so archival inserts can activate trigger-based projections.
  const modelsDir = path.join(config.data_dir, ".models");
  const archivalStore = createMemoryStore(userId, config.data_dir);
  tools.push(
    ...createArchivalMemoryTools(archivalStore, (text) => embed(text, modelsDir), projectionStore),
  );

  tools.push(createConversationSearchTool(path.join(config.data_dir, "history")));

  // Worker tools: dispatch and check background research sessions.
  // The registry lives for the lifetime of this tool set (one per user session).
  // Workers write completion facts to the user's archival memory store.
  const workerRegistry = createWorkerRegistry();
  tools.push(...createWorkerTools(config, archivalStore, workerRegistry));

  return tools;
}
