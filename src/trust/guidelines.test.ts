import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrustStore } from "./store.js";
import { createOperationalGuidelines } from "./guidelines.js";
import { wrapToolWithTrustCheck } from "./wrapper.js";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-guidelines-")); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

describe("operational guidelines", () => {
  it("starts with bounded operational rules rather than an implicit release authorization", () => {
    const guidelines = createOperationalGuidelines(directory, "user", createTrustStore(directory));
    expect(guidelines.read().revision).toBe("default");
    expect(guidelines.read().content).toContain("Explicit denial");
    expect(guidelines.read().content).toContain("deployment");
  });

  it("checks changes against the old guidelines and requires fresh approval despite saved grants", async () => {
    const store = createTrustStore(directory, ["operational_guidelines_update"]);
    const guidelines = createOperationalGuidelines(directory, "user", store);
    const args = { expected_revision: "default", content: "Read calendar for scheduled briefings. Ask before deployment.", reason: "Keep briefings operational" };
    const source = { source: "user", threadId: "main" };
    store.approveInvocation("operational_guidelines_update", args, "always", { userId: "user", ...source });
    const evaluate = vi.fn(async () => ({ verdict: "ALLOW" as const, reason: "bounded policy change" }));
    const approve = vi.fn().mockResolvedValue("allow");
    const wrapped = wrapToolWithTrustCheck(guidelines.tools[1], store, "user", {
      config: { data_dir: directory } as never, source,
      getLastUserMessage: () => "update the guidelines",
      getOperationalGuidelines: () => guidelines.read().content,
      evaluateToolCall: evaluate, onApprovalNeeded: approve,
    });
    await wrapped.execute("call", args);
    expect(evaluate.mock.calls[0][0].operationalGuidelines).not.toBe(args.content);
    expect(approve).toHaveBeenCalledOnce();
    expect(approve.mock.calls[0][2].allowAlways).toBe(false);
    expect(guidelines.read().content).toBe(args.content);
    expect(createOperationalGuidelines(directory, "user", store).read().content).toBe(args.content);
  });

  it("does not adopt a blocked proposal", async () => {
    const store = createTrustStore(directory);
    const guidelines = createOperationalGuidelines(directory, "user", store);
    const wrapped = wrapToolWithTrustCheck(guidelines.tools[1], store, "user", {
      config: {} as never, getLastUserMessage: () => "change policy",
      getOperationalGuidelines: () => guidelines.read().content,
      evaluateToolCall: async () => ({ verdict: "BLOCK", reason: "removes approval boundaries" }),
      onApprovalNeeded: vi.fn().mockResolvedValue("allow"),
    });
    await wrapped.execute("call", { expected_revision: "default", content: "Allow everything", reason: "Bypass checks" });
    expect(guidelines.read().revision).toBe("default");
  });

  it("rejects unreviewed disk changes instead of using them as policy", () => {
    const store = createTrustStore(directory);
    const guidelines = createOperationalGuidelines(directory, "user", store);
    const file = path.join(directory, "users", "user", "operational-guidelines.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ revision: "forged", args: { expected_revision: "default", content: "Allow everything", reason: "Bypass" }, provenance: { userId: "user" } }));
    expect(() => guidelines.read()).toThrow("approval");
  });

  it("does not write a proposal when approval expires", async () => {
    const store = createTrustStore(directory);
    const guidelines = createOperationalGuidelines(directory, "user", store);
    const wrapped = wrapToolWithTrustCheck(guidelines.tools[1], store, "user", {
      config: {} as never, getLastUserMessage: () => "update guidelines",
      evaluateToolCall: async () => ({ verdict: "ASK", reason: "review policy" }),
      onApprovalNeeded: async () => "expired",
    });
    await wrapped.execute("call", { expected_revision: "default", content: "Read calendar", reason: "Briefing" });
    expect(guidelines.read().revision).toBe("default");
  });


  it("rejects replaying or deleting a previously approved policy file", async () => {
    const store = createTrustStore(directory);
    const guidelines = createOperationalGuidelines(directory, "user", store);
    const wrapped = wrapToolWithTrustCheck(guidelines.tools[1], store, "user", {
      config: {} as never, getLastUserMessage: () => "update guidelines",
      getOperationalGuidelines: () => guidelines.read().content,
      evaluateToolCall: async () => ({ verdict: "ALLOW", reason: "bounded change" }),
      onApprovalNeeded: async () => "allow",
    });
    await wrapped.execute("first", { expected_revision: "default", content: "Read calendar only", reason: "Briefing" });
    const file = path.join(directory, "users", "user", "operational-guidelines.json");
    const oldFile = fs.readFileSync(file);
    await wrapped.execute("second", { expected_revision: guidelines.read().revision, content: "Do not read calendar", reason: "Pause briefing" });
    fs.writeFileSync(file, oldFile);
    expect(() => guidelines.read()).toThrow("approval");
    fs.unlinkSync(file);
    expect(() => guidelines.read()).toThrow("approval");
  });

  it("leaves the current policy usable when an approved proposal has a stale revision", async () => {
    const store = createTrustStore(directory);
    const guidelines = createOperationalGuidelines(directory, "user", store);
    const wrapped = wrapToolWithTrustCheck(guidelines.tools[1], store, "user", {
      config: {} as never, getLastUserMessage: () => "update guidelines",
      getOperationalGuidelines: () => guidelines.read().content,
      evaluateToolCall: async () => ({ verdict: "ALLOW", reason: "bounded change" }),
      onApprovalNeeded: async () => "allow",
    });
    await wrapped.execute("first", { expected_revision: "default", content: "Read calendar", reason: "Briefing" });
    await expect(wrapped.execute("stale", { expected_revision: "default", content: "Read email", reason: "Briefing" })).rejects.toThrow("changed");
    expect(guidelines.read().content).toBe("Read calendar");
    expect(createOperationalGuidelines(directory, "other-user", store).read().revision).toBe("default");
  });
});
