import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  createMcpExtension,
  type ExtensionFactory,
  type McpExtensionOptions,
  type McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import { writeJsonAtomic } from "../durable-file.js";

type NativeCredentials = NonNullable<McpExtensionOptions["credentials"]>;
type ServerStore = ReturnType<NativeCredentials["forServer"]>;
type OAuthState = Awaited<ReturnType<ServerStore["load"]>>;
type CredentialStore = Pick<NativeCredentials, "forServer" | "tokens" | "remove">;

/** Supply the native credential protocol with per-user storage and cross-process refresh locks. */
export function createMcpCredentials(directory: string): CredentialStore {
  const file = path.join(directory, "mcp-auth.json");

  const withStates = <T>(callback: (states: Record<string, OAuthState>) => { result: T; changed?: boolean }): T => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const release = lockfile.lockSync(file, { realpath: false });
    try {
      let states: Record<string, OAuthState> = {};
      if (fs.existsSync(file)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Invalid MCP credential store");
        }
        states = parsed as Record<string, OAuthState>;
      }
      const outcome = callback(states);
      if (outcome.changed) {
        writeJsonAtomic(file, states);
      }
      return outcome.result;
    } finally {
      release();
    }
  };

  return {
    forServer(serverUrl) {
      const key = new URL(serverUrl).href;
      return {
        load: () => withStates((states) => ({ result: states[key] })),
        save: (state) => withStates((states) => {
          states[key] = state;
          return { result: undefined, changed: true };
        }),
        async withRefreshLock<T>(callback: () => Promise<T>): Promise<T> {
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          // Match pi's lock name so operator sign-in and Bryti cannot rotate the same token concurrently.
          const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
          const release = await lockfile.lock(path.join(directory, `mcp-auth-refresh-${hash}`), {
            realpath: false, stale: 20000,
            retries: { retries: 250, factor: 1, minTimeout: 100, maxTimeout: 100 },
          });
          try {
            return await callback();
          } finally {
            await release();
          }
        },
      };
    },
    tokens(serverUrl) {
      const key = new URL(serverUrl).href;
      return withStates((states) => ({ result: states[key]?.tokens }));
    },
    remove(serverUrl) {
      const key = new URL(serverUrl).href;
      return withStates((states) => {
        const present = key in states;
        delete states[key];
        return { result: present, changed: present };
      });
    },
  };
}

/** Load only operator-owned per-user MCP configuration, without implicit codemode activation. */
export function createBrytiMcpExtension(dataDirectory: string, userId: string): ExtensionFactory {
  const usersDirectory = path.resolve(dataDirectory, "users");
  const directory = path.resolve(usersDirectory, userId);
  if (path.dirname(directory) !== usersDirectory) {
    throw new Error("MCP configuration must stay within the user directory");
  }
  const file = path.join(directory, "mcp.json");

  return (pi) => {
    const errors: string[] = [];
    if (fs.existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Invalid MCP configuration");
        }
        const servers = (parsed as Record<string, unknown>).mcpServers;
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
          throw new Error("Invalid MCP server list");
        }
        for (const [name, raw] of Object.entries(servers)) {
          try {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
              throw new Error("Invalid MCP server");
            }
            const config = raw as McpServerConfig;
            let exposure: McpServerConfig["exposure"] = "deferred";
            if (config.exposure === "hidden") {
              exposure = "hidden";
            }
            const toolExposure: Record<string, "hidden" | "deferred"> = {};
            for (const [tool, exposure] of Object.entries(config.toolExposure ?? {})) {
              toolExposure[tool] = "deferred";
              if (exposure === "hidden") {
                toolExposure[tool] = "hidden";
              }
            }
            pi.registerMcpServer(name, { ...config, exposure, toolExposure });
          } catch {
            errors.push(`Invalid MCP server configuration for ${name} in ${file}`);
          }
        }
      } catch {
        errors.push(`Cannot load MCP configuration from ${file}`);
      }
    }
    const credentials = createMcpCredentials(directory);
    return createMcpExtension({
      loadConfig: () => ({ servers: [], autoEnableCodemode: false, errors }),
      // The SDK declares a concrete class with private members but uses only this public protocol.
      credentials: credentials as NativeCredentials,
      logPath: path.join(directory, "mcp.log"),
      openUrl() {
        throw new Error(`MCP sign-in requires the operator's pi CLI with PI_CODING_AGENT_DIR=${directory}`);
      },
      updateConfig() {
        throw new Error(`Edit ${file} as the operator and reload the session`);
      },
    })(pi);
  };
}
