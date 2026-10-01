import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { createBrytiMcpExtension, createMcpCredentials } from "./mcp.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bryti-mcp-"));
  directories.push(directory);
  return directory;
}

function registrations(directory: string, user: string) {
  const registered = new Map<string, McpServerConfig>();
  const pi = {
    registerMcpServer(name: string, config: McpServerConfig) { registered.set(name, config); },
    on: vi.fn(), registerCommand: vi.fn(), registerFlag: vi.fn(), registerShortcut: vi.fn(),
  } as unknown as ExtensionAPI;
  createBrytiMcpExtension(directory, user)(pi);
  return registered;
}

describe("per-user MCP configuration", () => {
  it("does not discover global or project MCP configurations by default", () => {
    const directory = setup();
    fs.mkdirSync(path.join(directory, ".pi"));
    fs.writeFileSync(path.join(directory, ".pi", "mcp.json"), JSON.stringify({
      mcpServers: { unwanted: { command: "do-not-run" } },
    }));
    expect(registrations(directory, "alice").size).toBe(0);
  });

  it("isolates users and disables codemode at both server and tool level", () => {
    const directory = setup();
    const userDirectory = path.join(directory, "users", "alice");
    fs.mkdirSync(userDirectory, { recursive: true });
    fs.writeFileSync(path.join(userDirectory, "mcp.json"), JSON.stringify({
      autoEnableCodemode: true,
      mcpServers: { docs: { url: "https://example.com/mcp", exposure: "codemode",
        toolExposure: { read: "direct", admin: "hidden", search: "codemode-deferred" } } },
    }));
    expect(registrations(directory, "alice").get("docs")).toMatchObject({
      exposure: "deferred", toolExposure: { read: "deferred", admin: "hidden", search: "deferred" },
    });
    expect(registrations(directory, "bob").size).toBe(0);
  });

  it("preserves a server explicitly hidden by the operator", () => {
    const directory = setup();
    const userDirectory = path.join(directory, "users", "alice");
    fs.mkdirSync(userDirectory, { recursive: true });
    fs.writeFileSync(path.join(userDirectory, "mcp.json"), JSON.stringify({
      mcpServers: { private: { url: "https://example.com/mcp", exposure: "hidden" } },
    }));
    expect(registrations(directory, "alice").get("private")).toMatchObject({ exposure: "hidden" });
  });

  it("rejects user paths outside the system-managed user directory", () => {
    expect(() => registrations(setup(), "../../outside")).toThrow("user directory");
  });
});

describe("MCP credentials", () => {
  it("persists OAuth state privately and isolates users", async () => {
    const directory = setup();
    const alice = createMcpCredentials(path.join(directory, "alice"));
    const bob = createMcpCredentials(path.join(directory, "bob"));
    const url = "https://example.com/mcp";
    const state = { tokens: { access_token: "test-only-token", token_type: "Bearer" } };
    await alice.forServer(url).save(state);
    expect(await createMcpCredentials(path.join(directory, "alice")).forServer(url).load()).toEqual(state);
    expect(await bob.forServer(url).load()).toBeUndefined();
    expect(fs.statSync(path.join(directory, "alice", "mcp-auth.json")).mode & 0o777).toBe(0o600);
  });

  it("serializes refreshes from separate store instances", async () => {
    const directory = setup();
    const first = createMcpCredentials(directory).forServer("https://example.com/mcp");
    const second = createMcpCredentials(directory).forServer("https://example.com/mcp");
    const order: string[] = [];
    let release!: () => void;
    const pending = first.withRefreshLock(async () => {
      order.push("first");
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await vi.waitFor(() => expect(order).toEqual(["first"]));
    const next = second.withRefreshLock(async () => { order.push("second"); });
    release();
    await Promise.all([pending, next]);
    expect(order).toEqual(["first", "second"]);
  });
});
