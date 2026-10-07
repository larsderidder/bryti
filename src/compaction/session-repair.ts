import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { repairToolUseResultPairing } from "./transcript-repair.js";

/** Repair provider context after canonical projection, without rewriting audit history or usage. */
export function createTranscriptRepairExtension(
  resolveMissing?: Parameters<typeof repairToolUseResultPairing>[1],
): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event) => {
      const report = repairToolUseResultPairing(event.messages, resolveMissing);
      return { messages: report.messages };
    });
  };
}
