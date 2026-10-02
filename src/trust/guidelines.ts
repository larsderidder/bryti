import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { writeJsonAtomic } from "../durable-file.js";
import { hashToolArgs, registerToolCapabilities, type TrustStore } from "./store.js";
import { toolSuccess } from "../tools/result.js";

export const DEFAULT_OPERATIONAL_GUIDELINES = `Routine file reads, local checks, and bounded reads from configured integrations may support user-requested or scheduled tasks.
Continuing an approved task is not a new task merely because the last message is short. Check these guidelines for standing authorization, but do not infer deployment, publication, payments, or destructive authority from a status request or an unseen task file.
Task-specific standing authorization must state its project, permitted actions, destinations, and limits. It does not authorize unrelated work.
Explicit denial stops the action until the user changes that decision. Approval expiry means no decision was received; consider asking later if still relevant, without immediate retries, loops, or alternate access routes.
Operational guidelines can only be changed through operational_guidelines_update. Every update requires guardrail evaluation against the current guidelines and explicit user approval. Never use proposed guidelines to authorize their own adoption.`;

const updateSchema = Type.Object({
  expected_revision: Type.String({ description: "Revision returned by operational_guidelines_read" }),
  content: Type.String({ minLength: 1, maxLength: 8000, description: "Complete replacement guidelines, with explicit scope and limits. No credentials." }),
  reason: Type.String({ minLength: 1, maxLength: 1000, description: "Why this policy change is needed" }),
});

type GuidelinesUpdate = { expected_revision: string; content: string; reason: string };
export interface OperationalGuidelines { revision: string; content: string }

/** Load only policy revisions backed by an explicit approval receipt, never arbitrary file edits. */
export function createOperationalGuidelines(dataDir: string, userId: string, trustStore: TrustStore) {
  const file = path.join(dataDir, "users", userId, "operational-guidelines.json");
  const receiptScope = { userId, source: "guidelines" };

  function read(): OperationalGuidelines {
    const latestReceipt = trustStore.listApproved().filter((record) => record.kind === "invocation"
      && record.tool === "operational_guidelines_update" && record.duration === "always"
      && record.provenance?.userId === userId && record.provenance.source === "guidelines").at(-1);
    if (!fs.existsSync(file)) {
      if (latestReceipt) {
        throw new Error("Operational guidelines are missing their approved revision; approval review is required");
      }
      return { revision: "default", content: DEFAULT_OPERATIONAL_GUIDELINES };
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 64_000) {
        throw new Error("Operational guidelines have no valid approval receipt");
      }
      const record = JSON.parse(fs.readFileSync(fd, "utf8")) as { revision?: string; receiptId?: string; args?: GuidelinesUpdate };
      const args = record.args;
      if (!args || typeof args.content !== "string" || args.content.length > 8000 || !args.content.trim()
        || typeof args.expected_revision !== "string" || typeof args.reason !== "string"
        || record.revision !== hashToolArgs(args)
        || !latestReceipt || latestReceipt.id !== record.receiptId || latestReceipt.argsHash !== record.revision) {
        throw new Error("Operational guidelines have no valid approval receipt");
      }
      return { revision: record.revision, content: args.content };
    } finally {
      fs.closeSync(fd);
    }
  }

  registerToolCapabilities("operational_guidelines_read", { level: "safe" });
  registerToolCapabilities("operational_guidelines_update", {
    level: "elevated", capabilities: ["filesystem"], requiresFreshApproval: true,
    reason: "Changes the operational guidelines used by the guardrail. Requires review and explicit approval for each revision.",
  });
  const readSchema = Type.Object({});
  const readTool: AgentTool<typeof readSchema> = {
    name: "operational_guidelines_read", label: "Operational guidelines",
    description: "Read your approved operational guidelines and revision. These define standing task scope for permission checks.",
    parameters: readSchema,
    async execute() {
      return toolSuccess(read());
    },
  };
  const updateTool: AgentTool<typeof updateSchema> = {
    name: "operational_guidelines_update", label: "Update operational guidelines",
    description: "Propose complete replacement operational guidelines. Always checked against the existing policy and explicitly approved by the user. Use this tool, not file writes. A stale revision cannot overwrite a newer policy.",
    parameters: updateSchema,
    async execute(_id, args: GuidelinesUpdate) {
      // Check again after the approval wait, which may overlap another thread's update.
      if (read().revision !== args.expected_revision) {
        throw new Error("Operational guidelines changed while awaiting approval. Read and review the current revision before proposing another update.");
      }
      if (!trustStore.consumeInvocationOnce("operational_guidelines_update", args, receiptScope)) {
        throw new Error("Operational guidelines update has no explicit approval receipt");
      }
      const revision = hashToolArgs(args);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const receipt = trustStore.approveInvocation("operational_guidelines_update", args, "always", receiptScope);
      writeJsonAtomic(file, { revision, receiptId: receipt.id, args });
      return toolSuccess({ revision, updated: true });
    },
  };
  const tools: AgentTool<any>[] = [readTool, updateTool];
  return { read, tools };
}
