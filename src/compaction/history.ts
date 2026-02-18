/**
 * History turn limiting.
 *
 * Ported from OpenClaw (src/agents/pi-embedded-runner/history.ts).
 *
 * Limits the session message list to the last N user turns (and their
 * associated assistant/tool responses). Used as a safety valve when compaction
 * is not available or as an additional guard against runaway context growth.
 *
 * With 200K+ context models this is unlikely to trigger in practice, but it
 * prevents edge cases where a very long session survives compaction intact.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Return the last `limit` user turns (and their responses) from a message list.
 *
 * A "turn" is a user message plus everything that follows it up to the next
 * user message. If `limit` is undefined, zero, or negative, the original list
 * is returned unchanged.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  let userCount = 0;
  let cutIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        // cutIndex is the start of the (limit+1)th user turn from the end,
        // which we want to discard. The next iteration will set it correctly.
        return messages.slice(cutIndex);
      }
      cutIndex = i;
    }
  }

  // Fewer than limit user turns in the list: return unchanged.
  return messages;
}
