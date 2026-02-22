/**
 * Tool registry. Bryti-specific tools registered as pi SDK custom tools,
 * supplementing pi's built-in tools.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { createFileTools } from "./files.js";
import { createSkillInstallTool } from "./skill-install.js";
import { createCoreMemoryTools } from "./core-memory-tool.js";
import { createArchivalMemoryTools } from "./archival-memory-tool.js";
import { createConversationSearchTool } from "./conversation-search-tool.js";
import { createProjectionTools, createProjectionStore } from "../projection/index.js";
import { createWorkerTools, createWorkerRegistry } from "../workers/index.js";
import { toolSuccess } from "./result.js";
import { embed } from "../memory/embeddings.js";
import { createMemoryStore } from "../memory/store.js";
import path from "node:path";
import type { Config } from "../config.js";
import type { CoreMemory } from "../memory/core-memory.js";
import type { WorkerTriggerCallback } from "../workers/tools.js";
import { registerToolCapabilities } from "../trust/index.js";

/** Callback invoked when the agent requests a restart. */
export type RestartCallback = (reason: string) => Promise<void>;

type BrytiTool = AgentTool<any>;

const restartSchema = Type.Object({
  reason: Type.String({ description: "Brief description of why a restart is needed (shown in logs)" }),
});

/**
 * Create all bryti tools based on configuration.
 */
export function createTools(
  config: Config,
  coreMemory: CoreMemory,
  userId: string,
  onWorkerTrigger?: WorkerTriggerCallback,
  onRestart?: RestartCallback,
): BrytiTool[] {
  const tools: BrytiTool[] = [];

  // File tools (main agent can read/write in its sandbox)
  tools.push(...createFileTools(config.tools.files.base_dir));

  // Skill installation: fetch and install skills from URLs or local paths
  tools.push(createSkillInstallTool(config.data_dir));

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

  // Restart tool: agent can trigger a clean process restart.
  // Used after writing or modifying extensions so new tools load immediately.
  if (onRestart) {
    const restartTool: AgentTool<typeof restartSchema> = {
      name: "system_restart",
      label: "system_restart",
      description:
        "Restart the bryti process to reload extensions and config. " +
        "Use this after writing or modifying an extension file, or after changing config.yml. " +
        "The user will receive a 'Restarting' message, then 'Back online' when ready. " +
        "Always tell the user what you changed and why you are restarting before calling this.",
      parameters: restartSchema,
      async execute(
        _toolCallId: string,
        { reason }: { reason: string },
      ): Promise<AgentToolResult<unknown>> {
        await onRestart(reason);
        // process.exit() will have been called by onRestart — this line is unreachable
        // but satisfies the return type.
        return toolSuccess({ restarting: true });
      },
    };
    tools.push(restartTool);
    registerToolCapabilities("system_restart", {
      level: "elevated",
      capabilities: ["shell"],
      reason: "Restarts the bryti process.",
    });
  }

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
