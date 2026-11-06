import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

/** Find a persistent context-loss marker without treating a generated summary as restored history. */
export function contextLoss(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "compaction") {
      continue;
    }
    const details = entry.details as { bryti?: { degraded?: boolean; contextLossId?: string } } | undefined;
    if (details?.bryti?.degraded) {
      return details.bryti.contextLossId ?? entry.id;
    }
    return undefined;
  }
  return undefined;
}

/** Return one disclosure per context-loss boundary; acknowledgement follows durable response staging. */
export function pendingContextWarning(manager: SessionManager): { id: string; text: string } | undefined {
  const entries = manager.getBranch();
  const id = contextLoss(entries);
  if (!id || entries.some((entry) => entry.type === "custom" && entry.customType === "bryti-context-disclosure" &&
      (entry.data as { id?: string } | undefined)?.id === id)) {
    return undefined;
  }
  return { id, text: "Some older conversation context was omitted to keep this session usable. Full history is retained for lookup. " +
    "This does not resolve paused tasks or authorize repeating earlier actions." };
}
