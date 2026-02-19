/**
 * Format projections for system prompt injection.
 */

import type { Projection } from "./store.js";

/**
 * Render a short projection list suitable for inclusion in the system prompt.
 * Capped at maxItems to avoid crowding context.
 */
export function formatProjectionsForPrompt(projections: Projection[], maxItems = 15): string {
  if (projections.length === 0) {
    return "No upcoming projections.";
  }

  const capped = projections.slice(0, maxItems);
  const lines = capped.map((p) => {
    const when = p.trigger_on_fact
      ? `[waiting for: "${p.trigger_on_fact}"]`
      : p.resolved_when
        ? `[${p.resolved_when.slice(0, 16)}, ${p.resolution}]`
        : p.raw_when
          ? `[${p.raw_when}, ${p.resolution}]`
          : `[someday]`;
    const recur = p.recurrence ? ` [recurring: ${p.recurrence}]` : "";
    const ctx = p.context ? ` — ${p.context}` : "";
    return `- ${when}${recur} ${p.summary}${ctx} (id: ${p.id})`;
  });

  const overflow = projections.length > maxItems
    ? `\n(${projections.length - maxItems} more — use get_projections to see all)`
    : "";

  return lines.join("\n") + overflow;
}
