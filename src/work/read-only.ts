import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Inspect the complete turn, including failed calls and orphan results, before releasing future checks. */
export function readOnlyTurnEvidence(entries: SessionEntry[], eligibleTools: ReadonlySet<string>): string[] | null {
  if (entries.length === 0) {
    return null;
  }
  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall" && !eligibleTools.has(block.name)) {
          return null;
        }
      }
    } else if (message.role === "toolResult" && !eligibleTools.has(message.toolName)) {
      return null;
    }
  }
  return entries.map((entry) => entry.id);
}
