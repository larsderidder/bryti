/**
 * Tool registry.
 *
 * Pibot-specific tools registered as pi SDK custom tools.
 * These supplement pi's built-in tools (read/write/edit/bash).
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { createWebSearchTool } from "./web-search.js";
import { createFetchUrlTool } from "./fetch-url.js";
import { createFileTools } from "./files.js";
import { createMemoryTools } from "./memory-tool.js";
import type { Config } from "../config.js";
import type { MemoryManager } from "../memory.js";

export { createWebSearchTool };
export { createFetchUrlTool };
export { createFileTools };
export { createMemoryTools };

/**
 * Type for pibot tools (AgentTool from pi).
 */
export type PibotTool = AgentTool<any>;

/**
 * Create all pibot tools based on configuration.
 */
export function createTools(config: Config, memoryManager: MemoryManager): PibotTool[] {
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
  tools.push(...createMemoryTools(memoryManager));

  return tools;
}
