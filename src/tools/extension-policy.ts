import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerToolCapabilities, type TrustStore } from "../trust/store.js";
import { wrapToolWithTrustCheck, type TrustWrapperContext } from "../trust/wrapper.js";
import { validateToolSchema } from "./schema-validation.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ToolCapabilities } from "../trust/store.js";

export interface ExtensionTrustContext {
  trustStore?: TrustStore;
  userId: string;
  context?: TrustWrapperContext;
}

/** Apply Bryti permissions and schema quarantine before extension tools enter native discovery. */
export function createExtensionToolPolicy(options: ExtensionTrustContext) {
  const protectedDefinitions = new WeakSet<object>();
  const quarantinedNames = new Set<string>();

  const protect = <T extends ToolDefinition<any, any, any>>(definition: T, sourcePath?: string): T => {
    if (protectedDefinitions.has(definition)) {
      return definition;
    }
    const issues = validateToolSchema(definition.name, definition.parameters);
    let exposure = definition.exposure ?? "deferred";
    if (exposure !== "hidden" && exposure !== "model-only") {
      exposure = "deferred";
    }
    if (issues.length > 0) {
      quarantinedNames.add(definition.name);
      exposure = "hidden";
      console.error(`[extensions] Quarantined tool ${definition.name}: ${issues.map((issue) => issue.message).join("; ")}`);
    } else {
      quarantinedNames.delete(definition.name);
    }
    if (!options.trustStore || !options.context) {
      exposure = "hidden";
    }
    // Server annotations are unverified and cannot grant privileges.
    registerToolCapabilities(definition.name, {
      level: "elevated", capabilities: ["network", "filesystem", "shell"],
      reason: "Extension tool with unrestricted access.",
    });
    const binding = options.context?.config.trust?.read_only_extensions?.find((entry) =>
      sourcePath && path.isAbsolute(sourcePath) && path.resolve(entry.path) === path.resolve(sourcePath)
      && entry.tools.includes(definition.name));
    const sourceDigest = (): string | undefined => {
      if (!sourcePath || !path.isAbsolute(sourcePath)) {
        return undefined;
      }
      try {
        const stat = fs.statSync(sourcePath);
        if (!stat.isFile() || stat.size > 1_000_000) {
          return undefined;
        }
        return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
      } catch {
        return undefined;
      }
    };
    const registrationDigest = sourceDigest();
    const reviewedAtRegistration = Boolean(binding && registrationDigest === binding.sha256);
    const protectedDefinition: T = {
      ...definition,
      exposure,
      async execute(callId, args, signal, onUpdate, context) {
        if (issues.length > 0) {
          throw new Error(`Tool ${definition.name} is quarantined because its schema is unsupported`);
        }
        if (!options.trustStore || !options.context) {
          throw new Error(`Tool ${definition.name} has no Bryti approval context`);
        }
        const executable: AgentTool = {
          ...definition,
          execute: (id, params, abortSignal, update) => definition.execute(id, params, abortSignal, update, context),
        };
        const digest = sourceDigest();
        const sourceId = `${sourcePath ?? "<runtime>"}:${registrationDigest ?? "unverified"}:${digest ?? "unverified"}`;
        let capabilities: ToolCapabilities = {
          level: "elevated", capabilities: ["network", "filesystem", "shell"],
          reason: "Extension tool with unrestricted access.",
          sourceId,
        };
        if (reviewedAtRegistration && digest === binding?.sha256) {
          capabilities = { level: "elevated", capabilities: ["network"], approvalRequired: false,
            sourceId, reason: "Operator-reviewed read-only integration. Guardrail evaluation still applies." };
        }
        return wrapToolWithTrustCheck(executable, options.trustStore, options.userId, options.context, capabilities)
          .execute(callId, args, signal, onUpdate);
      },
    };
    protectedDefinitions.add(protectedDefinition);
    return protectedDefinition;
  };

  /** Intercept runtime registrations, including MCP reconnects and changed tool lists. */
  const wrapFactory = (factory: ExtensionFactory): ExtensionFactory => (pi) => factory({
    ...pi,
    registerTool(definition) {
      pi.registerTool(protect(definition));
    },
  });

  return { protect, wrapFactory, quarantinedNames };
}
