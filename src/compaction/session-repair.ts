import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { repairToolUseResultPairing } from "./transcript-repair.js";

/** Repair provider context after canonical projection, without rewriting audit history or usage. */
export function createTranscriptRepairExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event) => {
      const report = repairToolUseResultPairing(event.messages);
      return { messages: report.messages };
    });
  };
}
