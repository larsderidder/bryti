import { describe, expect, it, vi } from "vitest";
import { WhatsAppBridge } from "./whatsapp.js";

describe("WhatsApp approval reactions", () => {
  function bridgeWithPendingApproval() {
    const bridge = new WhatsAppBridge("/tmp/bryti-whatsapp-test", ["31612345678"]);
    const resolve = vi.fn();
    const pending = { resolve, messageId: "msg-123" };
    const internals = bridge as unknown as {
      pendingApprovals: Map<string, typeof pending>;
      approvalByMessageId: Map<string, string>;
      handleReactionApproval(raw: unknown): boolean;
    };
    internals.pendingApprovals.set("approval-key", pending);
    internals.approvalByMessageId.set("msg-123", "approval-key");
    return { bridge, internals, resolve };
  }

  it("allows once from a thumbs-up reaction event", () => {
    const { internals, resolve } = bridgeWithPendingApproval();

    const consumed = internals.handleReactionApproval({
      reaction: { key: { id: "msg-123" }, text: "👍" },
    });

    expect(consumed).toBe(true);
    expect(resolve).toHaveBeenCalledWith("allow");
    expect(internals.pendingApprovals.has("approval-key")).toBe(false);
    expect(internals.approvalByMessageId.has("msg-123")).toBe(false);
  });

  it("allows always from a star reaction message", () => {
    const { internals, resolve } = bridgeWithPendingApproval();

    const consumed = internals.handleReactionApproval({
      message: { reactionMessage: { key: { id: "msg-123" }, text: "⭐" } },
    });

    expect(consumed).toBe(true);
    expect(resolve).toHaveBeenCalledWith("allow_always");
  });

  it("denies from a thumbs-down reaction", () => {
    const { internals, resolve } = bridgeWithPendingApproval();

    const consumed = internals.handleReactionApproval({
      reaction: { key: { id: "msg-123" }, text: "👎" },
    });

    expect(consumed).toBe(true);
    expect(resolve).toHaveBeenCalledWith("deny");
  });

  it("ignores reactions for unknown messages", () => {
    const { internals, resolve } = bridgeWithPendingApproval();

    const consumed = internals.handleReactionApproval({
      reaction: { key: { id: "other-message" }, text: "👍" },
    });

    expect(consumed).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(internals.pendingApprovals.has("approval-key")).toBe(true);
  });

  it("keeps text approval fallback working", () => {
    const { bridge, resolve } = bridgeWithPendingApproval();

    const consumed = bridge.checkApprovalResponse("always");

    expect(consumed).toBe(true);
    expect(resolve).toHaveBeenCalledWith("allow_always");
  });
});
