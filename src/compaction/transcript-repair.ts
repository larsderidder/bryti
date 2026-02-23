/**
 * Transcript repair for pi session files.
 *
 * Anthropic-compatible providers reject (HTTP 400) requests where assistant
 * tool calls are not immediately followed by matching tool results. Session
 * files can end up malformed in two concrete ways:
 *
 *   1. A partial write during a crash leaves a tool_use block in the
 *      assistant message with no corresponding tool_result in the next
 *      user turn. The provider sees an unclosed tool call and rejects.
 *
 *   2. A race during session flush writes tool_result messages out of
 *      order or duplicated relative to their tool_use. The provider
 *      expects results to appear in the same order as their matching
 *      calls, so any mismatch causes a 400.
 *
 * Repairs by: reordering results to follow their matching tool call, inserting
 * synthetic error results for missing ones, and dropping duplicates and orphans.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

type ToolCallLike = {
  id: string;
  name?: string;
};

/**
 * Extract all tool-call blocks from an assistant message.
 *
 * Checks for three type strings ("toolCall", "toolUse", "functionCall")
 * because different SDK versions and provider adapters use different names
 * for the same concept. Normalising here lets the rest of the repair logic
 * work against a single representation regardless of which adapter produced
 * the session file.
 */
function extractToolCallsFromAssistant(
  msg: Extract<AgentMessage, { role: "assistant" }>,
): ToolCallLike[] {
  const content = msg.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCallLike[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) {
      continue;
    }
    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function extractToolResultId(msg: Extract<AgentMessage, { role: "toolResult" }>): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) {
    return toolCallId;
  }
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) {
    return toolUseId;
  }
  return null;
}

/**
 * Construct a synthetic tool_result for a tool call that has no matching
 * result in the session file.
 *
 * The content string "[bryti] missing tool result" is intentionally prefixed
 * with the agent name so the model can identify this as a repair artifact
 * rather than a real tool failure. That distinction matters: the model should
 * reason "this call was lost during a crash" rather than "the tool returned
 * an error", which would lead to incorrect retry or error-handling behaviour.
 */
function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [
      {
        type: "text",
        text: "[bryti] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

export type ToolUseRepairReport = {
  messages: AgentMessage[];
  /**
   * Synthetic error results that were inserted for missing tool results.
   * Logged on startup; frequent non-zero values indicate that tool calls are
   * being lost before their results are persisted — a systemic session
   * persistence issue worth investigating.
   */
  added: Array<Extract<AgentMessage, { role: "toolResult" }>>;
  /**
   * Number of tool_result messages dropped because a result with the same ID
   * had already been seen. Logged on startup; frequent non-zero values
   * indicate that the session flush is writing results more than once, which
   * is a systemic session persistence issue.
   */
  droppedDuplicateCount: number;
  /**
   * Number of tool_result messages dropped because no matching tool_use call
   * existed anywhere in the transcript. Logged on startup; frequent non-zero
   * values indicate that tool_use messages are being lost while their results
   * survive, again a systemic session persistence issue.
   */
  droppedOrphanCount: number;
  /** Whether any messages were reordered or changed. */
  changed: boolean;
};

/**
 * Repair tool-call/tool-result pairing in a message list. Returns the
 * repaired list and a report. If nothing needed fixing, returns the
 * original array unchanged (same reference).
 */
export function repairToolUseResultPairing(messages: AgentMessage[]): ToolUseRepairReport {
  const out: AgentMessage[] = [];
  const added: Array<Extract<AgentMessage, { role: "toolResult" }>> = [];
  const seenToolResultIds = new Set<string>();
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  let changed = false;

  const pushToolResult = (msg: Extract<AgentMessage, { role: "toolResult" }>) => {
    const id = extractToolResultId(msg);
    if (id && seenToolResultIds.has(id)) {
      droppedDuplicateCount += 1;
      changed = true;
      return;
    }
    if (id) {
      seenToolResultIds.add(id);
    }
    out.push(msg);
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;

    if (role !== "assistant") {
      // Free-floating toolResult entries must be dropped: they cause strict
      // providers to reject the request.
      if (role !== "toolResult") {
        out.push(msg);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
      continue;
    }

    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;

    // Phase 1: build the expected tool-call sequence from this assistant message.
    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) {
      out.push(msg);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));

    // Phase 2: collect all tool results (and any non-result messages) that
    // appear between this assistant turn and the next one.
    const spanResultsById = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
    const remainder: AgentMessage[] = [];

    let j = i + 1;
    for (; j < messages.length; j++) {
      const next = messages[j];
      if (!next || typeof next !== "object") {
        remainder.push(next);
        continue;
      }

      const nextRole = (next as { role?: unknown }).role;
      if (nextRole === "assistant") {
        break;
      }

      if (nextRole === "toolResult") {
        const toolResult = next as Extract<AgentMessage, { role: "toolResult" }>;
        const id = extractToolResultId(toolResult);
        if (id && toolCallIds.has(id)) {
          if (seenToolResultIds.has(id)) {
            droppedDuplicateCount += 1;
            changed = true;
            continue;
          }
          if (spanResultsById.has(id)) {
            // Duplicate within this span
            droppedDuplicateCount += 1;
            changed = true;
          } else {
            spanResultsById.set(id, toolResult);
          }
          continue;
        }
      }

      if ((next as { role?: unknown }).role !== "toolResult") {
        remainder.push(next);
      } else {
        // Phase 5 (inline): drop orphan results that have no matching call.
        droppedOrphanCount += 1;
        changed = true;
      }
    }

    out.push(msg);

    if (spanResultsById.size > 0 && remainder.length > 0) {
      changed = true;
    }

    // Phase 3: emit results in call order (reordering any that were out of
    // sequence). Phase 4: for any call with no matching result, insert a
    // synthetic error result so the transcript is structurally valid.
    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      if (existing) {
        pushToolResult(existing);
      } else {
        const missing = makeMissingToolResult({ toolCallId: call.id, toolName: call.name });
        added.push(missing);
        changed = true;
        pushToolResult(missing);
      }
    }

    for (const rem of remainder) {
      out.push(rem);
    }

    i = j - 1;
  }

  return {
    messages: changed ? out : messages,
    added,
    droppedDuplicateCount,
    droppedOrphanCount,
    changed,
  };
}
