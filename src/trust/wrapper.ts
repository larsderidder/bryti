import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  canonicalizeToolArgs,
  checkPermission,
  extractToolDestination,
  getToolCapabilities,
  setPendingApproval,
  hashToolArgs,
  summarizeToolArgs,
  type ApprovalProvenance,
  type TrustStore,
} from "./store.js";
import { evaluateToolCall, type GuardrailInput, type GuardrailResult } from "./guardrail.js";
import type { Config } from "../config.js";
import type { ApprovalResult } from "../channels/types.js";
import type { ModelInfra } from "../model-infra.js";

export type ApprovalCallback = (prompt: string, approvalKey: string) => Promise<ApprovalResult>;
export type GuardrailEvaluator = (input: GuardrailInput) => Promise<GuardrailResult>;

export interface TrustWrapperContext {
  config: Config;
  getLastUserMessage: () => string | undefined;
  onApprovalNeeded?: ApprovalCallback;
  modelInfra?: ModelInfra;
  evaluateToolCall?: GuardrailEvaluator;
  source?: Omit<ApprovalProvenance, "userId">;
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
  system_restart: "Restart to pick up changes",
  shell_exec: "Run a shell command",
  http_request: "Make a web request",
  web_search: "Search the public web from the main conversation",
  fetch_url: "Fetch and extract text from a web page in the main conversation",
};

const ALWAYS_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function humanToolDescription(toolName: string, reason?: string): string {
  return TOOL_DESCRIPTIONS[toolName] ?? reason ?? "Perform an action that needs your permission";
}

function nextAlwaysApprovalExpiry(): string {
  return new Date(Date.now() + ALWAYS_APPROVAL_TTL_MS).toISOString();
}

function denied(toolName: string): AgentToolResult<unknown> {
  return {
    content: [{
      type: "text" as const,
      text: `User denied permission for ${toolName}. Tell the user the action was not taken.`,
    }],
  } as AgentToolResult<unknown>;
}

function aborted(toolName: string): AgentToolResult<unknown> {
  return {
    content: [{
      type: "text" as const,
      text: `Permission flow for ${toolName} was aborted before execution. Tell the user the action was not taken.`,
    }],
  } as AgentToolResult<unknown>;
}

function blocked(reason: string): AgentToolResult<unknown> {
  return {
    content: [{
      type: "text" as const,
      text: `Blocked: ${reason}. Tell the user this action was blocked for safety and explain why.`,
    }],
  } as AgentToolResult<unknown>;
}

function buildProvenance(userId: string, context?: TrustWrapperContext): ApprovalProvenance {
  return {
    userId,
    threadId: context?.source?.threadId,
    platform: context?.source?.platform,
    channelId: context?.source?.channelId,
    channelThreadId: context?.source?.channelThreadId,
    automationId: context?.source?.automationId,
    source: context?.source?.source ?? "agent",
  };
}

function buildOperationSummary(toolName: string, params: unknown): string {
  const destination = extractToolDestination(params);
  if (destination) {
    return `${toolName} destination ${destination}`;
  }
  return toolName;
}

function buildApprovalPrompt(
  heading: string,
  toolName: string,
  reason: string,
  params: unknown,
  capsReason?: string,
): string {
  const description = humanToolDescription(toolName, capsReason);
  const operation = buildOperationSummary(toolName, params);
  const argsSummary = summarizeToolArgs(params);
  return [
    `<b>${escapeHtml(heading)}</b>`,
    "",
    escapeHtml(description),
    `Operation: ${escapeHtml(operation)}`,
    `Arguments: ${escapeHtml(argsSummary)}`,
    `Check: ${escapeHtml(reason)}`,
    "Approval scope: Allow once runs only this call. Always stores this exact argument set for 30 days, scoped to the current user, source, platform, channel, topic, and thread when known.",
  ].join("\n");
}

async function runGuardrail(
  tool: AgentTool<any>,
  params: unknown,
  context?: TrustWrapperContext,
  signal?: AbortSignal,
): Promise<AbortableResult<GuardrailResult>> {
  if (!context?.config) {
    return { verdict: "ASK", reason: "Guardrail unavailable." };
  }
  const input: GuardrailInput = {
    toolName: tool.name,
    args: canonicalizeToolArgs(params),
    userMessage: context.getLastUserMessage?.(),
    toolDescription: tool.description,
  };
  try {
    if (context.evaluateToolCall) {
      return await awaitAbortable(context.evaluateToolCall(input), signal);
    }
    return await awaitAbortable(evaluateToolCall(context.config, input, context.modelInfra), signal);
  } catch {
    return { verdict: "ASK", reason: "Guardrail unavailable." };
  }
}

function signalAborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

const ABORTED_PROMISE = Symbol("aborted promise");
type AbortableResult<T> = T | typeof ABORTED_PROMISE;

async function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<AbortableResult<T>> {
  if (!signal) {
    return await promise;
  }
  if (signal.aborted) {
    promise.catch(() => {});
    return ABORTED_PROMISE;
  }

  let cleanup = () => {};
  const abortPromise = new Promise<typeof ABORTED_PROMISE>((resolve) => {
    const onAbort = () => resolve(ABORTED_PROMISE);
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup = () => signal.removeEventListener("abort", onAbort);
  });
  promise.catch(() => {});

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    cleanup();
  }
}

export function wrapToolWithTrustCheck<T extends AgentTool<any>>(
  tool: T,
  trustStore: TrustStore,
  userId: string,
  context?: TrustWrapperContext,
): T {
  const originalExecute = tool.execute;

  const wrappedExecute: typeof originalExecute = async (toolCallId, params, signal, onUpdate) => {
    const caps = getToolCapabilities(tool.name);

    if (caps.level === "safe" || caps.level === "guarded") {
      return originalExecute.call(tool, toolCallId, params, signal, onUpdate);
    }

    const provenance = buildProvenance(userId, context);
    if (signalAborted(signal)) {
      return aborted(tool.name);
    }
    if (trustStore.consumeInvocationOnce(tool.name, params, provenance)) {
      if (signalAborted(signal)) {
        return aborted(tool.name);
      }
      return originalExecute.call(tool, toolCallId, params, signal, onUpdate);
    }

    if (trustStore.isInvocationApproved(tool.name, params, provenance)) {
      if (signalAborted(signal)) {
        return aborted(tool.name);
      }
      return originalExecute.call(tool, toolCallId, params, signal, onUpdate);
    }

    const guardrailResult = await runGuardrail(tool, params, context, signal);
    if (guardrailResult === ABORTED_PROMISE) {
      return aborted(tool.name);
    }
    if (signalAborted(signal)) {
      return aborted(tool.name);
    }

    if (guardrailResult.verdict === "BLOCK") {
      return blocked(guardrailResult.reason);
    }

    const toolAvailable = trustStore.hasToolApproval(tool.name);
    const needsApproval = !toolAvailable || guardrailResult.verdict === "ASK";
    if (!needsApproval) {
      trustStore.consumeOnce(tool.name);
    }
    if (needsApproval) {
      const permission = checkPermission(tool.name, trustStore);
      let reason = permission.blockReason ?? guardrailResult.reason;
      let heading = "Permission request";
      if (guardrailResult.verdict === "ASK") {
        reason = guardrailResult.reason;
        heading = "Confirmation needed";
      }
      const prompt = buildApprovalPrompt(
        heading,
        tool.name,
        reason,
        params,
        caps.reason,
      );

      if (!context?.onApprovalNeeded) {
        setPendingApproval(userId, tool.name);
        return {
          content: [{
            type: "text" as const,
            text: prompt.replace(/<[^>]+>/g, ""),
          }],
        } as AgentToolResult<unknown>;
      }

      const argsHash = hashToolArgs(params);
      const approvalKey = `trust:${userId}:${tool.name}:${argsHash.slice(0, 16)}:${toolCallId}`;
      const result = await awaitAbortable(context.onApprovalNeeded(prompt, approvalKey), signal);
      if (result === ABORTED_PROMISE) {
        return aborted(tool.name);
      }
      if (signalAborted(signal)) {
        return aborted(tool.name);
      }
      if (result === "deny") {
        return denied(tool.name);
      }

      if (result === "allow_always") {
        const expiresAt = nextAlwaysApprovalExpiry();
        if (!toolAvailable) {
          trustStore.approve(tool.name, "always", provenance, expiresAt);
        }
        trustStore.approveInvocation(tool.name, params, "always", provenance, expiresAt);
      } else {
        trustStore.approveInvocation(tool.name, params, "once", provenance);
        trustStore.consumeInvocationOnce(tool.name, params, provenance);
      }
    }

    if (signalAborted(signal)) {
      return aborted(tool.name);
    }
    return originalExecute.call(tool, toolCallId, params, signal, onUpdate);
  };

  return { ...tool, execute: wrappedExecute };
}

export function wrapToolsWithTrustChecks(
  tools: AgentTool<any>[],
  trustStore: TrustStore,
  userId: string,
  context?: TrustWrapperContext,
): AgentTool<any>[] {
  return tools.map((tool) => wrapToolWithTrustCheck(tool, trustStore, userId, context));
}
