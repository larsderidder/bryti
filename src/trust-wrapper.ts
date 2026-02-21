/**
 * Trust-aware tool wrapper.
 *
 * Wraps tool execute() functions with permission checks. For elevated tools:
 * 1. If pre-approved or user-approved: run through LLM guardrail
 * 2. If guardrail says ALLOW: execute silently
 * 3. If guardrail says ASK: block and ask the user
 * 4. If guardrail says BLOCK: block with explanation
 * 5. If not approved at all: block and ask for tool-level approval first
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  checkPermission,
  setPendingApproval,
  getToolCapabilities,
  type TrustStore,
} from "./trust.js";
import { evaluateToolCall, type GuardrailResult } from "./guardrail.js";
import type { Config } from "./config.js";

/**
 * Context needed for guardrail evaluation.
 */
export interface TrustWrapperContext {
  config: Config;
  /** The last user message (for guardrail context). */
  getLastUserMessage: () => string | undefined;
}

/**
 * Wrap a tool's execute function with trust check + LLM guardrail.
 */
export function wrapToolWithTrustCheck<T extends AgentTool<any>>(
  tool: T,
  trustStore: TrustStore,
  userId: string,
  context?: TrustWrapperContext,
): T {
  const originalExecute = tool.execute;

  const wrappedExecute: typeof originalExecute = async (toolCallId, params, signal, onUpdate) => {
    const caps = getToolCapabilities(tool.name);

    // Safe and guarded tools: always execute
    if (caps.level === "safe" || caps.level === "guarded") {
      return originalExecute.call(tool, toolCallId, params, signal, onUpdate);
    }

    // Elevated: first check if the tool itself is approved
    const permResult = checkPermission(tool.name, trustStore);
    if (!permResult.allowed) {
      // Tool not approved at all; ask for tool-level permission first
      setPendingApproval(userId, tool.name);
      return {
        content: [{
          type: "text" as const,
          text: permResult.blockReason ?? `Permission denied for ${tool.name}.`,
        }],
      } as AgentToolResult<unknown>;
    }

    // Tool is approved. Run the LLM guardrail on the specific arguments.
    if (context?.config) {
      const argsStr = typeof params === "string" ? params : JSON.stringify(params);
      let guardrailResult: GuardrailResult;
      try {
        guardrailResult = await evaluateToolCall(context.config, {
          toolName: tool.name,
          args: argsStr,
          userMessage: context.getLastUserMessage?.(),
          toolDescription: tool.description,
        });
      } catch {
        // Guardrail failure: fail safe to ASK
        guardrailResult = { verdict: "ASK", reason: "Guardrail unavailable." };
      }

      if (guardrailResult.verdict === "BLOCK") {
        return {
          content: [{
            type: "text" as const,
            text: `Blocked: ${guardrailResult.reason}. ` +
              `Tell the user this action was blocked for safety and explain why.`,
          }],
        } as AgentToolResult<unknown>;
      }

      if (guardrailResult.verdict === "ASK") {
        setPendingApproval(userId, `${tool.name}:${toolCallId}`);
        return {
          content: [{
            type: "text" as const,
            text: `Guardrail flagged this action: ${guardrailResult.reason}. ` +
              `Ask the user to confirm: describe what you're about to do and why, ` +
              `then ask "Should I go ahead?"`,
          }],
        } as AgentToolResult<unknown>;
      }

      // ALLOW: fall through to execution
    }

    return originalExecute.call(tool, toolCallId, params, signal, onUpdate);
  };

  return { ...tool, execute: wrappedExecute };
}

/**
 * Wrap all tools in an array with trust checks.
 */
export function wrapToolsWithTrustChecks(
  tools: AgentTool<any>[],
  trustStore: TrustStore,
  userId: string,
  context?: TrustWrapperContext,
): AgentTool<any>[] {
  return tools.map((tool) => wrapToolWithTrustCheck(tool, trustStore, userId, context));
}
