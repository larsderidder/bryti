/**
 * Trust-aware tool wrapper.
 *
 * Wraps tool execute() functions with permission checks. If a tool
 * requires elevated access and isn't approved, the execute returns
 * an error result telling the agent to ask the user.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  checkPermission,
  setPendingApproval,
  type TrustStore,
} from "./trust.js";

/**
 * Wrap a tool's execute function with a trust check.
 *
 * If the tool is blocked, the original execute never runs. Instead
 * the agent receives an error result instructing it to ask the user.
 */
export function wrapToolWithTrustCheck<T extends AgentTool<any>>(
  tool: T,
  trustStore: TrustStore,
  userId: string,
): T {
  const originalExecute = tool.execute;

  const wrappedExecute: typeof originalExecute = async (toolCallId, params, signal, onUpdate) => {
    const result = checkPermission(tool.name, trustStore);

    if (!result.allowed) {
      // Register that we're waiting for approval for this tool
      setPendingApproval(userId, tool.name);

      return {
        content: [
          {
            type: "text" as const,
            text: result.blockReason ?? `Permission denied for ${tool.name}.`,
          },
        ],
      } as AgentToolResult<unknown>;
    }

    return originalExecute.call(tool, toolCallId, params, signal, onUpdate);
  };

  return { ...tool, execute: wrappedExecute };
}

/**
 * Wrap all tools in an array with trust checks.
 * Only wraps tools that have registered capabilities at "elevated" level.
 */
export function wrapToolsWithTrustChecks(
  tools: AgentTool<any>[],
  trustStore: TrustStore,
  userId: string,
): AgentTool<any>[] {
  return tools.map((tool) => wrapToolWithTrustCheck(tool, trustStore, userId));
}
