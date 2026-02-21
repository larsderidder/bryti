/**
 * Tool registry.
 *
 * Pibot-specific tools registered as pi SDK custom tools.
 * These supplement pi's built-in tools (read/write/edit/bash).
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
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
import type { WorkerTriggerCallback } from "../workers/tools.js";

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
 *
 * @param onWorkerTrigger  Called when a worker's completion fact triggers projections.
 *                         Use this to inject an immediate message into the agent queue.
 */
export function createTools(
  config: Config,
  coreMemory: CoreMemory,
  userId: string,
  onWorkerTrigger?: WorkerTriggerCallback,
): PibotTool[] {
  const tools: PibotTool[] = [];

  // File tools (main agent can read/write in its sandbox)
  if (config.tools.files.enabled) {
    tools.push(...createFileTools(config.tools.files.base_dir));
  }

  // NOTE: web_search and fetch_url are NOT given to the main agent.
  // External content is processed by workers in isolation (security boundary).
  // The main agent reads worker results via read_file.

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
  // The projection store is passed so worker completion can trigger projections
  // immediately (instead of waiting for the 5-minute scheduler tick).
  const workerRegistry = createWorkerRegistry();
  tools.push(...createWorkerTools(
    config, archivalStore, workerRegistry, false, projectionStore, onWorkerTrigger,
  ));

  return tools;
}
