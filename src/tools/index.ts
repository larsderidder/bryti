/**
 * Tool registry. Bryti-specific tools registered as pi SDK custom tools,
 * supplementing pi's built-in tools.
 *
 * Which tool groups are registered is controlled by config.agent_def.tool_groups.
 * By default (personal-assistant preset) all groups are registered, matching
 * the original behavior. Focused agents can opt in to only the groups they need.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { createFileTools } from "./files.js";
import { createSystemLogTool } from "./system-log.js";
import { createPiSessionTools } from "./pi-sessions.js";
import { createSkillInstallTool } from "./skill-install.js";
import { createCoreMemoryTools } from "./core-memory-tool.js";
import { createArchivalMemoryTools } from "./archival-memory-tool.js";
import { createConversationSearchTool } from "./conversation-search-tool.js";
import { createProjectionTools, createProjectionStore, type ProjectionStore } from "../projection/index.js";
import { createWorkerTools, createWorkerRegistry } from "../workers/index.js";
import { toolSuccess } from "./result.js";
import { embed } from "../memory/embeddings.js";
import { createMemoryStore } from "../memory/store.js";
import path from "node:path";
import type { Config, ToolGroup } from "../config.js";
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
 * Create bryti tools based on configuration.
 *
 * Only tool groups listed in config.agent_def.tool_groups are registered.
 * The default (personal-assistant preset) enables all groups.
 *
 * Pass an existing `projectionStore` to share the single store instance
 * created by the agent session. If omitted a new store is created here
 * (backward-compatible, but creates a second connection to the same DB).
 */
export function createTools(
  config: Config,
  coreMemory: CoreMemory,
  userId: string,
  onWorkerTrigger?: WorkerTriggerCallback,
  onRestart?: RestartCallback,
  projectionStore?: ProjectionStore,
): BrytiTool[] {
  const tools: BrytiTool[] = [];
  const groups = new Set<ToolGroup>(config.agent_def.tool_groups);

  // ---------------------------------------------------------------------------
  // Shared stores: created regardless of which tool groups are enabled so that
  // inter-group dependencies (archival triggers projections, workers write to
  // archival) work correctly when both groups are present.
  // ---------------------------------------------------------------------------

  const resolvedProjectionStore = projectionStore ?? createProjectionStore(userId, config.data_dir);
  const modelsDir = path.join(config.data_dir, ".models");
  const archivalStore = createMemoryStore(userId, config.data_dir);

  // ---------------------------------------------------------------------------
  // SECURITY BOUNDARY: web_search and fetch_url are intentionally excluded
  // from the main agent's tool set. All external network access goes through
  // workers, which run in isolated sessions with scoped file access.
  //
  // Rationale: a web page or search result could contain prompt-injected
  // instructions. Processing untrusted content inside the main agent session
  // would let an attacker influence the agent's memory, projections, or tool
  // calls. Workers are disposable; the main agent only sees their sanitised
  // result files.
  // ---------------------------------------------------------------------------

  // files — file_write sandboxed to data dir.
  // Reading is handled by the SDK's built-in `read` and `ls` tools (always present).
  if (groups.has("files")) {
    tools.push(...createFileTools(config.data_dir));
  }

  // system_log — read runtime logs
  if (groups.has("system_log")) {
    tools.push(createSystemLogTool(path.join(config.data_dir, "logs")));
  }

  // extensions_management — skill_install + system_restart
  if (groups.has("extensions_management")) {
    tools.push(createSkillInstallTool(config.data_dir));
    registerToolCapabilities("skill_install", {
      level: "elevated",
      capabilities: ["network", "filesystem"],
      reason: "Installs skills from URLs or copies local directories into the skills folder.",
    });
  }

  // memory_core — core_memory_append, core_memory_replace
  if (groups.has("memory_core")) {
    tools.push(...createCoreMemoryTools(coreMemory));
  }

  // projections — projection_create, projection_resolve, projection_list, projection_link
  //
  // Created before archival tools so the projection store is available when
  // archival inserts need to activate trigger-based projections.
  if (groups.has("projections")) {
    tools.push(...createProjectionTools(resolvedProjectionStore, config.agent.timezone));
  }

  // memory_archival — archival_insert, archival_search
  //
  // Passes the projection store so inserts can trigger projections immediately.
  if (groups.has("memory_archival")) {
    tools.push(
      ...createArchivalMemoryTools(
        archivalStore,
        (text) => embed(text, modelsDir),
        resolvedProjectionStore,
      ),
    );
  }

  // memory_conversation — conversation_search
  if (groups.has("memory_conversation")) {
    tools.push(createConversationSearchTool(path.join(config.data_dir, "history")));
  }

  // pi_sessions — pi_session_list, pi_session_read, pi_session_search, pi_session_inject
  if (groups.has("pi_sessions")) {
    tools.push(...createPiSessionTools());
    registerToolCapabilities("pi_session_inject", {
      level: "elevated",
      capabilities: ["filesystem"],
      reason: "Injects messages into pi coding agent session files.",
    });
  }

  // workers — worker_dispatch, worker_check, worker_interrupt, worker_steer
  //
  // The registry lives for the lifetime of this tool set (one per user session).
  // Workers write completion facts to the user's archival memory store.
  // The projection store is passed so worker completion can trigger projections
  // immediately (instead of waiting for the 5-minute scheduler tick).
  if (groups.has("workers")) {
    const workerRegistry = createWorkerRegistry();
    tools.push(...createWorkerTools(
      config, archivalStore, workerRegistry, false, resolvedProjectionStore, onWorkerTrigger,
    ));
  }

  // extensions_management (cont.) — system_restart
  //
  // Restart is part of the extensions_management group but depends on the
  // onRestart callback being provided, so it's registered separately here.
  if (groups.has("extensions_management") && onRestart) {
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
    // Elevated even though a restart sounds harmless: the guardrail ensures
    // the agent cannot be tricked into restart-looping by a malicious prompt
    // (e.g. "please restart every 10 seconds until I say stop").
    registerToolCapabilities("system_restart", {
      level: "elevated",
      capabilities: ["shell"],
      reason: "Restarts the bryti process.",
    });
  }

  // Register trust capabilities for well-known elevated tools that may be
  // loaded as extensions by the pi SDK. These are registered unconditionally
  // since extension loading happens outside of tool groups.
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
