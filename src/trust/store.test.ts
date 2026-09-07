import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createTrustStore,
  registerToolCapabilities,
  getToolCapabilities,
  checkPermission,
  setPendingApproval,
  checkPendingApproval,
  isAlwaysApproval,
  canonicalizeToolArgs,
  hashToolArgs,
  summarizeToolArgs,
  extractToolDestination,
} from "./store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TrustStore", () => {
  it("pre-approved tools grant tool availability only", () => {
    const store = createTrustStore(tmpDir, ["weather_weert"]);
    expect(store.isApproved("weather_weert")).toBe(true);
    expect(store.hasToolApproval("weather_weert")).toBe(true);
    expect(store.isInvocationApproved("weather_weert", { city: "Weert" }, { userId: "user1" })).toBe(false);
    expect(store.isApproved("unknown_tool")).toBe(false);
  });

  it("once tool approvals work and are consumed", () => {
    const store = createTrustStore(tmpDir);
    store.approve("shell_exec", "once", { userId: "user1", source: "test" });
    expect(store.hasToolApproval("shell_exec")).toBe(true);
    expect(store.consumeOnce("shell_exec")).toBe(true);
    expect(store.hasToolApproval("shell_exec")).toBe(false);
  });

  it("always tool approvals persist as legacy availability", () => {
    const store1 = createTrustStore(tmpDir);
    store1.approve("http_request", "always", { userId: "user1", source: "test" });
    expect(store1.hasToolApproval("http_request")).toBe(true);

    const store2 = createTrustStore(tmpDir);
    expect(store2.hasToolApproval("http_request")).toBe(true);
    expect(store2.isInvocationApproved("http_request", { url: "https://example.com" }, { userId: "user1" })).toBe(false);
  });

  it("revokes both once and always tool approvals", () => {
    const store = createTrustStore(tmpDir);
    store.approve("tool_a", "always", { userId: "user1", source: "test" });
    store.approve("tool_b", "once", { userId: "user1", source: "test" });
    store.revoke("tool_a");
    store.revoke("tool_b");
    expect(store.hasToolApproval("tool_a")).toBe(false);
    expect(store.hasToolApproval("tool_b")).toBe(false);
  });

  it("listApproved returns all sources with provenance", () => {
    const store = createTrustStore(tmpDir, ["pre_tool"]);
    store.approve("once_tool", "once", { userId: "user1", source: "test" });
    store.approve("always_tool", "always", { userId: "user2", threadId: "thread-a", source: "test" });
    const list = store.listApproved();
    expect(list).toHaveLength(3);
    expect(list.find((l) => l.tool === "pre_tool")?.duration).toBe("always");
    expect(list.find((l) => l.tool === "once_tool")?.duration).toBe("once");
    expect(list.find((l) => l.tool === "always_tool")?.provenance?.threadId).toBe("thread-a");
  });

  it("canonicalizes argument order for stable hashing", () => {
    const left = { b: 2, a: { d: 4, c: 3 } };
    const right = { a: { c: 3, d: 4 }, b: 2 };
    expect(canonicalizeToolArgs(left)).toBe(canonicalizeToolArgs(right));
    expect(hashToolArgs(left)).toBe(hashToolArgs(right));
  });

  it("redacts secrets from summaries and destinations", () => {
    const args = {
      url: "https://user:pass@example.com/hook?token=secret-token-value&ok=1",
      command: "curl -H Authorization:Bearer abc.defghijklmnopqrstuvwxyz123 https://example.com",
    };
    const summary = summarizeToolArgs(args);
    const destination = extractToolDestination(args);
    expect(summary).not.toContain("secret-token-value");
    expect(summary).not.toContain("user:pass");
    expect(destination).not.toContain("secret-token-value");
    expect(destination).toContain("https://");
  });

  it("roundtrips exact argument grants without storing raw secrets", () => {
    const store1 = createTrustStore(tmpDir);
    const grant = store1.approveInvocation("http_request", {
      method: "POST",
      url: "https://api.example.com/send",
      password: "correct horse battery staple",
    }, "always", { userId: "user1", threadId: "main", source: "inline" });

    const file = fs.readFileSync(path.join(tmpDir, "trust-approvals.json"), "utf-8");
    expect(file).not.toContain("correct horse battery staple");
    expect(file).toContain(grant.argsHash);

    const store2 = createTrustStore(tmpDir);
    expect(store2.isInvocationApproved("http_request", {
      url: "https://api.example.com/send",
      password: "correct horse battery staple",
      method: "POST",
    }, { userId: "user1", threadId: "main", source: "inline" })).toBe(true);
  });

  it("does not match exact grants for different arguments", () => {
    const store = createTrustStore(tmpDir);
    store.approveInvocation("shell_exec", { command: "npm test" }, "always", { userId: "user1" });
    expect(store.isInvocationApproved("shell_exec", { command: "npm run build" }, { userId: "user1" })).toBe(false);
  });

  it("does not match exact grants from another source user", () => {
    const store = createTrustStore(tmpDir);
    store.approveInvocation("shell_exec", { command: "npm test" }, "always", { userId: "user1" });
    expect(store.isInvocationApproved("shell_exec", { command: "npm test" }, { userId: "user2" })).toBe(false);
  });


  it("scopes exact grants to all stored provenance dimensions", () => {
    const store = createTrustStore(tmpDir);
    const args = { command: "npm test" };
    store.approveInvocation("shell_exec", args, "always", {
      userId: "user1",
      threadId: "main",
      platform: "telegram",
      channelId: "chat1",
      channelThreadId: "topic1",
      source: "user",
    });

    expect(store.isInvocationApproved("shell_exec", args, {
      userId: "user1",
      threadId: "main",
      platform: "telegram",
      channelId: "chat1",
      channelThreadId: "topic1",
      source: "user",
    })).toBe(true);
    expect(store.isInvocationApproved("shell_exec", args, {
      userId: "user1",
      threadId: "main",
      platform: "telegram",
      channelId: "chat1",
      channelThreadId: "topic2",
      source: "user",
    })).toBe(false);
    expect(store.isInvocationApproved("shell_exec", args, {
      userId: "user1",
      threadId: "main",
      platform: "whatsapp",
      channelId: "chat1",
      channelThreadId: "topic1",
      source: "user",
    })).toBe(false);
  });

  it("does not treat no-provenance invocation grants as cross-user approvals", () => {
    const store = createTrustStore(tmpDir);
    const args = { command: "npm test" };
    store.approveInvocation("shell_exec", args, "always");

    expect(store.isInvocationApproved("shell_exec", args)).toBe(true);
    expect(store.isInvocationApproved("shell_exec", args, { userId: "user1" })).toBe(false);
  });

  it("expires exact grants", () => {
    const store = createTrustStore(tmpDir);
    store.approveInvocation("shell_exec", { command: "npm test" }, "always", { userId: "user1" }, "2000-01-01T00:00:00.000Z");
    expect(store.isInvocationApproved("shell_exec", { command: "npm test" }, { userId: "user1" })).toBe(false);
  });

  it("revokes exact grants by id", () => {
    const store = createTrustStore(tmpDir);
    const grant = store.approveInvocation("shell_exec", { command: "npm test" }, "always", { userId: "user1" });
    expect(store.revokeGrant(grant.id)).toBe(true);
    expect(store.isInvocationApproved("shell_exec", { command: "npm test" }, { userId: "user1" })).toBe(false);
  });

  it("consumes exact once grants once", () => {
    const store = createTrustStore(tmpDir);
    store.approveInvocation("shell_exec", { command: "npm test" }, "once", { userId: "user1" });
    expect(store.consumeInvocationOnce("shell_exec", { command: "npm test" }, { userId: "user1" })).toBe(true);
    expect(store.isInvocationApproved("shell_exec", { command: "npm test" }, { userId: "user1" })).toBe(false);
  });

  it("loads legacy tool approval records as availability only", () => {
    fs.writeFileSync(path.join(tmpDir, "trust-approvals.json"), JSON.stringify([
      { tool: "shell_exec", grantedAt: "2025-01-01T00:00:00.000Z", duration: "always" },
    ]), "utf-8");
    const store = createTrustStore(tmpDir);
    expect(store.hasToolApproval("shell_exec")).toBe(true);
    expect(store.isInvocationApproved("shell_exec", { command: "rm -rf /tmp/nope" }, { userId: "user1" })).toBe(false);
  });
});

describe("Capability registry", () => {
  it("unregistered tools are Safe", () => {
    const caps = getToolCapabilities("some_random_tool");
    expect(caps.level).toBe("safe");
  });

  it("registered tools return their capabilities", () => {
    registerToolCapabilities("shell_exec", {
      level: "elevated",
      capabilities: ["shell", "network"],
      reason: "Runs arbitrary shell commands",
    });
    const caps = getToolCapabilities("shell_exec");
    expect(caps.level).toBe("elevated");
    expect(caps.capabilities).toContain("shell");
    expect(caps.capabilities).toContain("network");
  });
});

describe("checkPermission", () => {
  it("allows Safe tools", () => {
    const store = createTrustStore(tmpDir);
    const result = checkPermission("memory_archival_insert", store);
    expect(result.allowed).toBe(true);
  });

  it("allows Guarded tools", () => {
    registerToolCapabilities("web_search", { level: "guarded" });
    const store = createTrustStore(tmpDir);
    const result = checkPermission("web_search", store);
    expect(result.allowed).toBe(true);
  });

  it("blocks unavailable Elevated tools", () => {
    registerToolCapabilities("dangerous_tool", {
      level: "elevated",
      capabilities: ["network"],
    });
    const store = createTrustStore(tmpDir);
    const result = checkPermission("dangerous_tool", store);
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toContain("Permission required");
  });

  it("allows available Elevated tools", () => {
    registerToolCapabilities("approved_tool", {
      level: "elevated",
      capabilities: ["network"],
    });
    const store = createTrustStore(tmpDir, ["approved_tool"]);
    const result = checkPermission("approved_tool", store);
    expect(result.allowed).toBe(true);
  });
});

describe("Pending approval flow", () => {
  it("affirmative messages grant approval", () => {
    setPendingApproval("user1", "shell_exec");
    expect(checkPendingApproval("user1", "yes")).toBe("shell_exec");
  });

  it("negative messages clear pending without granting", () => {
    setPendingApproval("user1", "shell_exec");
    expect(checkPendingApproval("user1", "no")).toBeNull();
    expect(checkPendingApproval("user1", "yes")).toBeNull();
  });

  it("unrelated messages leave pending intact", () => {
    setPendingApproval("user1", "shell_exec");
    expect(checkPendingApproval("user1", "what's the weather?")).toBeNull();
    expect(checkPendingApproval("user1", "yes")).toBe("shell_exec");
  });

  it("cancels pending approvals on cancel", () => {
    setPendingApproval("user1", "shell_exec");
    expect(checkPendingApproval("user1", "cancel")).toBeNull();
    expect(checkPendingApproval("user1", "yes")).toBeNull();
  });

  it("works with Dutch affirmatives", () => {
    setPendingApproval("user1", "tool_x");
    expect(checkPendingApproval("user1", "ja")).toBe("tool_x");
  });

  it("isAlwaysApproval detects always variants", () => {
    expect(isAlwaysApproval("always")).toBe(true);
    expect(isAlwaysApproval("Always Allow")).toBe(true);
    expect(isAlwaysApproval("yes")).toBe(false);
  });
});
