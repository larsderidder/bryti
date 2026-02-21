/**
 * Tool registry.
 *
 * Bryti-specific tools registered as pi SDK custom tools.
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
import { registerToolCapabilities } from "../trust.js";

type BrytiTool = AgentTool<any>;

/**
 * Create all bryti tools based on configuration.
 *
 * @param onWorkerTrigger  Called when a worker's completion fact triggers projections.
 *                         Use this to inject an immediate message into the agent queue.
 */
export function createTools(
  config: Config,
  coreMemory: CoreMemory,
  userId: string,
  onWorkerTrigger?: WorkerTriggerCallback,
): BrytiTool[] {
  const tools: BrytiTool[] = [];

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

  // Register trust capabilities for well-known elevated tools.
  // Extension tools (loaded by pi SDK from data/files/extensions/) default to
  // elevated since they can execute arbitrary code. Known extension names are
  // registered explicitly for better permission prompts.
  registerToolCapabilities("shell_exec", {
    level: "elevated",
    capabilities: ["shell", "filesystem"],
    reason: "Runs shell commands with access to the system.",
  });
  registerToolCapabilities("http_request", {
    level: "elevated",
    capabilities: ["network"],
    reason: "Makes HTTP requests to external services.",
  });

  return tools;
}
