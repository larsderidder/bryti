/**
 * Trust-aware tool wrapper.
 *
 * Wraps tool execute() with permission checks and the LLM guardrail.
 * Elevated tools first need tool-level approval, then each invocation
 * goes through the guardrail (ALLOW / ASK / BLOCK). Safe and guarded
 * tools pass through without checks.
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
import type { ApprovalResult } from "./channels/types.js";

/**
 * Callback for interactive approval requests. Sends a prompt to the user
 * (inline buttons or text) and resolves with their decision.
 */
export type ApprovalCallback = (prompt: string, approvalKey: string) => Promise<ApprovalResult>;

/**
 * Context needed for guardrail evaluation.
 */
export interface TrustWrapperContext {
  config: Config;
  /** The last user message (for guardrail context). */
  getLastUserMessage: () => string | undefined;
  /** If provided, approval requests use this instead of text-based blocking. */
  onApprovalNeeded?: ApprovalCallback;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Human-readable labels for elevated tools, shown instead of raw tool names.
 */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  system_restart: "Restart to pick up changes",
  shell_exec: "Run a shell command",
  http_request: "Make a web request",
};

function humanToolDescription(toolName: string, reason?: string): string {
  return TOOL_DESCRIPTIONS[toolName] ?? reason ?? "Perform an action that needs your permission";
}

function denied(toolName: string): AgentToolResult<unknown> {
  return {
    content: [{
      type: "text" as const,
      text: `User denied permission for ${toolName}. Tell the user the action was not taken.`,
    }],
  } as AgentToolResult<unknown>;
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
      const description = humanToolDescription(tool.name, caps.reason);
      const prompt =
        `⚡ <b>Permission request</b>\n\n` +
        `${escapeHtml(description)}`;

      if (context?.onApprovalNeeded) {
        const approvalKey = `tool:${userId}:${tool.name}`;
        const result = await context.onApprovalNeeded(prompt, approvalKey);

        if (result === "deny") {
          return denied(tool.name);
        }

        const duration = result === "allow_always" ? "always" : "once";
        trustStore.approve(tool.name, duration);
        // Fall through to guardrail with the now-approved tool
      } else {
        // No inline approval available — fall back to text-based flow
        setPendingApproval(userId, tool.name);
        return {
          content: [{
            type: "text" as const,
            text: permResult.blockReason ?? `Permission denied for ${tool.name}.`,
          }],
        } as AgentToolResult<unknown>;
      }
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
        const description = humanToolDescription(tool.name, caps.reason);
        const prompt =
          `⚠️ <b>Confirmation needed</b>\n\n` +
          `${escapeHtml(description)}\n` +
          `${escapeHtml(guardrailResult.reason)}`;

        if (context?.onApprovalNeeded) {
          const approvalKey = `guardrail:${userId}:${toolCallId}`;
          const result = await context.onApprovalNeeded(prompt, approvalKey);

          if (result === "deny") {
            return denied(tool.name);
          }
          // allow or allow_always: fall through to execution
          // (guardrail "always allow" for a specific invocation isn't meaningful, treat same as once)
        } else {
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
