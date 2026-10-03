import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  canonicalizeToolArgs,
  extractToolDestination,
  getToolCapabilities,
  setPendingApproval,
  hashToolArgs,
  summarizeToolArgs,
  type ApprovalProvenance,
  type TrustStore,
} from "./store.js";
import type { ToolCapabilities } from "./store.js";
import { evaluateToolCall, type GuardrailInput, type GuardrailResult } from "./guardrail.js";
import type { Config } from "../config.js";
import type { ApprovalResult, ApprovalOpts } from "../channels/types.js";
import type { ModelInfra } from "../model-infra.js";

export type ApprovalCallback = (prompt: string, approvalKey: string, opts?: ApprovalOpts) => Promise<ApprovalResult>;
export type GuardrailEvaluator = (input: GuardrailInput) => Promise<GuardrailResult>;

export interface TrustWrapperContext {
  config: Config;
  getLastUserMessage: () => string | undefined;
  getOperationalGuidelines?: () => string;
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
  freshApproval = false,
): string {
  const description = humanToolDescription(toolName, capsReason);
  const operation = buildOperationSummary(toolName, params);
  let argsSummary = summarizeToolArgs(params);
  let scope = "Approval scope: Allow once runs only this call. Same call for 30 days stores this exact argument set, scoped to the current user, source, platform, channel, topic, and thread when known.";
  if (freshApproval) {
    argsSummary = summarizeToolArgs(params, 16_000);
    scope = "Approval scope: This policy revision only. Every future change requires a new guardrail check and explicit approval.";
  }
  return [
    `<b>${escapeHtml(heading)}</b>`,
    "",
    escapeHtml(description),
    `Operation: ${escapeHtml(operation)}`,
    `Arguments: ${escapeHtml(argsSummary)}`,
    `Check: ${escapeHtml(reason)}`,
    scope,
  ].join("\n");
}

async function runGuardrail(
  tool: AgentTool<any>,
  params: unknown,
  context?: TrustWrapperContext,
  signal?: AbortSignal,
): Promise<AbortableResult<GuardrailResult & { guidelinesHash?: string }>> {
  if (!context?.config) {
    return { verdict: "ASK", reason: "Guardrail unavailable.", evaluationFailed: true };
  }
  try {
    const input: GuardrailInput = {
      toolName: tool.name,
      args: canonicalizeToolArgs(params),
      userMessage: context.getLastUserMessage?.(),
      toolDescription: tool.description,
      operationalGuidelines: context.getOperationalGuidelines?.(),
    };
    let guidelinesHash: string | undefined;
    if (input.operationalGuidelines !== undefined) {
      guidelinesHash = hashToolArgs(input.operationalGuidelines);
    }
    let result: AbortableResult<GuardrailResult>;
    if (context.evaluateToolCall) {
      result = await awaitAbortable(context.evaluateToolCall(input), signal);
    } else {
      result = await awaitAbortable(evaluateToolCall(context.config, input, context.modelInfra, signal), signal);
    }
    if (result === ABORTED_PROMISE) {
      return result;
    }
    return { ...result, guidelinesHash };
  } catch {
    return { verdict: "ASK", reason: "Guardrail unavailable.", evaluationFailed: true };
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
  capabilities?: ToolCapabilities,
): T {
  const originalExecute = tool.execute;

  const wrappedExecute: typeof originalExecute = async (toolCallId, params, signal, onUpdate) => {
    const caps = capabilities ?? getToolCapabilities(tool.name);
    const freshApproval = caps.requiresFreshApproval || tool.name === "operational_guidelines_update";

    if (!freshApproval && (caps.level === "safe" || caps.level === "guarded")) {
      return originalExecute.call(tool, toolCallId, params, signal, onUpdate);
    }

    const provenance = buildProvenance(userId, context);
    if (caps.sourceId) {
      provenance.toolSource = caps.sourceId;
    }
    if (signalAborted(signal)) {
      return aborted(tool.name);
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
    if (guardrailResult.guidelinesHash) {
      provenance.guidelinesHash = guardrailResult.guidelinesHash;
    }

    // A saved confirmation can satisfy ASK, but never bypass the current safety verdict.
    let invocationApproved = false;
    if (!freshApproval && !guardrailResult.evaluationFailed) {
      invocationApproved = trustStore.consumeInvocationOnce(tool.name, params, provenance)
        || trustStore.isInvocationApproved(tool.name, params, provenance);
    }
    const needsApproval = freshApproval || (guardrailResult.verdict === "ASK" && !invocationApproved);
    if (!needsApproval) {
      trustStore.consumeOnce(tool.name);
    }
    if (needsApproval) {
      const reason = guardrailResult.reason;
      let heading = "Permission request";
      if (guardrailResult.verdict === "ASK") {
        heading = "Confirmation needed";
      }
      const prompt = buildApprovalPrompt(
        heading,
        tool.name,
        reason,
        params,
        caps.reason,
        freshApproval,
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
      const result = await awaitAbortable(context.onApprovalNeeded(prompt, approvalKey, { signal, allowAlways: !freshApproval }), signal);
      if (result === ABORTED_PROMISE) {
        return aborted(tool.name);
      }
      if (signalAborted(signal)) {
        return aborted(tool.name);
      }
      if (result === "deny") {
        return denied(tool.name);
      }
      if (result === "expired") {
        return {
          content: [{ type: "text", text: `Permission request for ${tool.name} expired without a decision. The action was not taken. This is not a user denial. You may consider requesting approval later if the task is still relevant, but do not retry immediately, loop, or bypass approval.` }],
          details: { approval: "expired", executed: false },
        };
      }
      if ((result !== "allow" && result !== "allow_always") || (freshApproval && result === "allow_always")) {
        return {
          content: [{ type: "text", text: `Permission request for ${tool.name} was cancelled. The action was not taken; no user denial was recorded.` }],
          details: { approval: "cancelled", executed: false },
        };
      }

      if (freshApproval) {
        // The policy tool consumes this ephemeral authorization before persisting its audit receipt.
        trustStore.approveInvocation(tool.name, params, "once", { userId, source: "guidelines" });
      } else if (result === "allow_always") {
        const expiresAt = nextAlwaysApprovalExpiry();
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
