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
} from "./store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TrustStore", () => {
  it("pre-approved tools are always approved", () => {
    const store = createTrustStore(tmpDir, ["weather_weert"]);
    expect(store.isApproved("weather_weert")).toBe(true);
    expect(store.isApproved("unknown_tool")).toBe(false);
  });

  it("once approvals work and are consumed", () => {
    const store = createTrustStore(tmpDir);
    store.approve("shell_exec", "once");
    expect(store.isApproved("shell_exec")).toBe(true);
    expect(store.consumeOnce("shell_exec")).toBe(true);
    expect(store.isApproved("shell_exec")).toBe(false);
  });

  it("always approvals persist to disk", () => {
    const store1 = createTrustStore(tmpDir);
    store1.approve("http_request", "always");
    expect(store1.isApproved("http_request")).toBe(true);

    // New store instance should still see it
    const store2 = createTrustStore(tmpDir);
    expect(store2.isApproved("http_request")).toBe(true);
  });

  it("revoke removes both once and always approvals", () => {
    const store = createTrustStore(tmpDir);
    store.approve("tool_a", "always");
    store.approve("tool_b", "once");
    store.revoke("tool_a");
    store.revoke("tool_b");
    expect(store.isApproved("tool_a")).toBe(false);
    expect(store.isApproved("tool_b")).toBe(false);
  });

  it("listApproved returns all sources", () => {
    const store = createTrustStore(tmpDir, ["pre_tool"]);
    store.approve("once_tool", "once");
    store.approve("always_tool", "always");
    const list = store.listApproved();
    expect(list).toHaveLength(3);
    expect(list.find((l) => l.tool === "pre_tool")?.duration).toBe("always");
    expect(list.find((l) => l.tool === "once_tool")?.duration).toBe("once");
    expect(list.find((l) => l.tool === "always_tool")?.duration).toBe("always");
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

  it("blocks unapproved Elevated tools", () => {
    registerToolCapabilities("dangerous_tool", {
      level: "elevated",
      capabilities: ["network"],
    });
    const store = createTrustStore(tmpDir);
    const result = checkPermission("dangerous_tool", store);
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toContain("Permission required");
  });

  it("allows pre-approved Elevated tools", () => {
    registerToolCapabilities("approved_tool", {
      level: "elevated",
      capabilities: ["network"],
    });
    const store = createTrustStore(tmpDir, ["approved_tool"]);
    const result = checkPermission("approved_tool", store);
    expect(result.allowed).toBe(true);
  });

  it("consumes once-approval on use", () => {
    registerToolCapabilities("once_tool", {
      level: "elevated",
      capabilities: ["shell"],
    });
    const store = createTrustStore(tmpDir);
    store.approve("once_tool", "once");

    const result1 = checkPermission("once_tool", store);
    expect(result1.allowed).toBe(true);

    const result2 = checkPermission("once_tool", store);
    expect(result2.allowed).toBe(false);
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
    // Pending is cleared
    expect(checkPendingApproval("user1", "yes")).toBeNull();
  });

  it("unrelated messages leave pending intact", () => {
    setPendingApproval("user1", "shell_exec");
    expect(checkPendingApproval("user1", "what's the weather?")).toBeNull();
    // Still pending
    expect(checkPendingApproval("user1", "yes")).toBe("shell_exec");
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
