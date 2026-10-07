/**
 * Agent session management.
 *
 * Wraps pi's createAgentSession() with bryti-specific config: persistent
 * per-user sessions, transcript repair before every prompt, core memory
 * injection into the system prompt, and custom tools.
 *
 * The pi SDK handles the agent loop, model routing, session persistence
 * (append-only JSONL), auto-compaction, streaming, and retry logic.
 *
 * Sessions persist across messages in data/sessions/<userId>/. The model
 * sees its actual prior tool calls and results in context; JSONL history
 * files are kept as an audit log for conversation search.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import type { CoreMemory } from "./memory/core-memory.js";
import { repairToolUseResultPairing } from "./compaction/transcript-repair.js";
import { createProjectionStore, formatProjectionsForPrompt, type ProjectionStore } from "./projection/index.js";
import { createBrytiSettingsManager, createModelInfra, resolveModel } from "./model-infra.js";
import { buildSystemPrompt, buildSystemPromptSections, SILENT_REPLY_TOKEN, type ToolSummary } from "./system-prompt.js";
import { createTopicDeliveryTracker } from "./channels/topic-delivery.js";
import { createTranscriptRepairExtension } from "./compaction/session-repair.js";
import { createBrytiMcpExtension } from "./tools/mcp.js";
import { createExtensionToolPolicy, type ExtensionTrustContext } from "./tools/extension-policy.js";
import { createToolDiscoveryExtension } from "./tools/tool-search.js";
import { GOOGLE_TOOL_NAMES } from "./integrations/google-tools.js";
import { CONTEXT_READ_TOOLS, createContextManagementExtension } from "./context-management.js";
import { createDiagnosticWriter, createSessionDiagnostics, createProviderDiagnosticsExtension } from "./session-diagnostics.js";
import { isSessionTurnReserved } from "./compaction/proactive.js";
import { collectSessionUsage } from "./session-usage.js";
import { createUsageTracker } from "./usage.js";
import { resolveEffectResult } from "./work/effects.js";

// Re-export for backward compatibility with index.ts
export { SILENT_REPLY_TOKEN };

/**
 * A loaded, persistent agent session for a single user.
 */
export interface UserSession {
  /** The underlying pi AgentSession. */
  session: AgentSession;
  /** Model registry, used by promptWithFallback() to resolve fallback models. */
  modelRegistry: ModelRegistry;
  /** User this session belongs to. */
  userId: string;
  /** Path to the per-user session directory on disk. */
  sessionDir: string;
  /** Timestamp of last user-initiated message (not scheduler). */
  lastUserMessageAt: number;
  /** Extension files that failed to load on startup. Empty if all loaded. */
  extensionErrors: Array<{ path: string; error: string }>;
  /** Called after auto-compaction completes successfully. Set by index.ts. */
  onCompactionComplete?: () => void;
  /**
   * The single ProjectionStore for this user. Shared with the tool set so
   * there is exactly one DB connection per user. Closed by dispose().
   */
  projectionStore: ProjectionStore;
  /** Clean up event listeners. Does NOT delete the session file. */
  dispose(): void | Promise<void>;
}



/**
 * Short human-readable summary of tool arguments for the audit log.
 * Gives the /log command enough context without storing raw LLM args.
 *
 * This output is for human audit trail consumption only (/log command).
 * It is never fed back to the model — it exists solely so operators can
 * read what the agent did without wading through raw JSON blobs.
 */
function buildArgsSummary(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  const a = args as Record<string, unknown>;

  switch (toolName) {
    case "memory_archival_search":
      return String(a.query ?? "");
    case "memory_archival_insert":
      return truncate(String(a.content ?? ""), 80);
    case "memory_core_append":
      return `${a.section}: ${truncate(String(a.content ?? ""), 60)}`;
    case "memory_core_replace":
      return String(a.section ?? "");
    case "memory_conversation_search":
      return String(a.query ?? "");
    case "projection_create":
      return truncate(String(a.summary ?? ""), 80);
    case "projection_resolve":
      return String(a.id ?? "");
    case "projection_list":
      return "";
    case "projection_link":
      return String(a.projection_id ?? "");
    case "worker_dispatch":
      return truncate(String(a.task ?? ""), 80);
    case "worker_check":
      return String(a.worker_id ?? "");
    case "worker_interrupt":
      return String(a.worker_id ?? "");
    case "worker_steer":
      return String(a.worker_id ?? "");
    case "read":
      return String(a.path ?? "");
    case "file_write":
      return String(a.path ?? "");
    case "ls":
      return String(a.path ?? "");
    default:
      return "";
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/**
 * Per-user session directory. Each user gets their own so continueRecent()
 * picks up the right session.
 */
function userSessionDir(config: Config, sessionKey: string): string {
  const dir = path.join(config.data_dir, "sessions", sessionKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Load (or create) a persistent agent session for a user.
 *
 * Opens an existing session file and loads its history, or creates a new
 * one if none exists. Transcript repair runs on load to fix any corrupted
 * tool-call/result pairings from a previous run.
 *
 * Call dispose() to clean up event listeners. The session file itself
 * survives; it's reused on the next message.
 */
export async function loadUserSession(
  config: Config,
  coreMemory: CoreMemory,
  userId: string,
  customTools: AgentTool[],
  existingProjectionStore?: ProjectionStore,
  sessionKey = userId,
  extensionTrust?: Omit<ExtensionTrustContext, "userId">,
): Promise<UserSession> {
  const { modelRuntime, modelRegistry, agentDir } = await createModelInfra(config);

  // --- 1. Model resolution ---
  // Resolve the configured model string to a registry entry. Throws if the
  // model is unknown so we fail fast before touching the session file.
  const model = resolveModel(config.agent.model, modelRegistry);
  if (!model) {
    throw new Error(
      `Model not found: ${config.agent.model}. Available: ${modelRegistry.getAvailable().map((m) => m.id).join(", ")}`,
    );
  }

  console.log(`Using model: ${model.id} (${model.provider})`);

  // Session manager: continue most recent session for this user, or create new.
  // Each user gets their own session directory so continueRecent finds the right file.
  const sessDir = userSessionDir(config, sessionKey);
  const isNewUser = !fs.existsSync(sessDir) || fs.readdirSync(sessDir).length === 0;
  const sessionManager = SessionManager.continueRecent(config.data_dir, sessDir);
  const sessionTools = customTools;
  const toolPolicy = createExtensionToolPolicy({ ...extensionTrust, userId });
  const promptTools: ToolSummary[] = sessionTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
  }));
  const extensionToolNames = new Set<string>();
  const trustedCodemodeDefinitions = new WeakSet<object>();
  const trustedSessionDefinitions = new WeakSet<object>();
  const eligibleContextTools = new Set(sessionTools.map((tool) => tool.name).filter((name) => CONTEXT_READ_TOOLS.has(name)));
  const diagnostics = createSessionDiagnostics({ userId, sessionKey, sessionId: sessionManager.getSessionId(),
    captureProvider: config.diagnostics?.capture_provider,
    write: createDiagnosticWriter(config.data_dir, config.diagnostics?.max_file_bytes),
  });

  // --- 2. Resource loader setup with system prompt override closure ---
  // The override closure captures core memory and the projection store so it
  // can read both at call time. session.reload() triggers the closure, which
  // means every prompt sees up-to-date memory and projections without restarting.
  //
  // Bryti has its own skills directory in the data dir, separate from the global
  // pi CLI skills. Skills are curated for bryti independently of the CLI.

  // Projection store for this user. Reuse the caller-supplied store when
  // available so there is exactly one DB connection per user. Create a new
  // one only as a fallback (tests, standalone use).
  const projectionStore = existingProjectionStore ?? createProjectionStore(userId, config.data_dir);

  const brytiSkillsDir = path.join(config.data_dir, "skills");
  const baseSkillPaths = fs.existsSync(brytiSkillsDir) ? [brytiSkillsDir] : [];

  // Expand ~ in paths declared in extension_files / skill_files. The skill
  // loader handles ~ natively, but additionalExtensionPaths goes through
  // resolvePackageSources which does not expand ~, so we do it here for both.
  function expandHome(p: string): string {
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
  }

  const additionalExtensionPaths = config.agent_def.extension_files
    .map(expandHome)
    .filter((p) => {
      if (!fs.existsSync(p)) {
        console.warn(`[extensions] Configured extension file not found, skipping: ${p}`);
        return false;
      }
      return true;
    });

  const additionalSkillPaths = [
    ...baseSkillPaths,
    ...config.agent_def.skill_files.map(expandHome).filter((p) => {
      if (!fs.existsSync(p)) {
        console.warn(`[skills] Configured skill file not found, skipping: ${p}`);
        return false;
      }
      return true;
    }),
  ];

  const loader = new DefaultResourceLoader({
    cwd: config.data_dir,
    agentDir,
    additionalExtensionPaths,
    additionalSkillPaths,
    extensionFactories: [
      { name: "bryti-codemode", factory: (pi) => createCodemodeExtension({ mode: "on", models: false })({
        ...pi,
        registerTool(definition) {
          trustedCodemodeDefinitions.add(definition);
          pi.registerTool(definition);
        },
      }) },
      { name: "bryti-mcp", factory: toolPolicy.wrapFactory(createBrytiMcpExtension(config.data_dir, userId)) },
      { name: "bryti-transcript-repair", factory: createTranscriptRepairExtension(
        (call) => resolveEffectResult(config.data_dir, userId, extensionTrust?.context?.source?.threadId, call, sessionManager.getSessionId()),
      ) },
      { name: "bryti-tool-search", factory: createToolDiscoveryExtension((activeTools) => {
        promptTools.splice(0, promptTools.length, ...activeTools.map((tool) => ({
          name: tool.name, description: tool.description,
        })));
      }) },
      { name: "bryti-context-management", factory: (pi) => createContextManagementExtension(
        sessionManager, config.context_management, eligibleContextTools,
      )({ ...pi, registerTool(definition) {
        trustedSessionDefinitions.add(definition);
        pi.registerTool(definition);
      } }) },
      { name: "bryti-prompt-sections", factory: (pi) => {
        pi.on("before_agent_start", (event) => {
          projectionStore.autoExpire(24);
          const projectionText = formatProjectionsForPrompt(projectionStore.getUpcoming(7));
          const hasPreviousAnswer = sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant");
          const prompt = buildSystemPromptSections(config, coreMemory.read(), promptTools, extensionToolNames,
            projectionText, { isNewUser: isNewUser && !hasPreviousAnswer });
          event.systemPromptOptions.customPrompt = prompt.instructions;
          for (const key of ["bryti_tools", "bryti_memory", "bryti_projections", "bryti_datetime", "bryti_operational_guidelines"]) {
            delete event.systemPromptOptions.sections[key];
          }
          Object.assign(event.systemPromptOptions.sections, prompt.sections);
          try {
            const guidelines = extensionTrust?.context?.getOperationalGuidelines?.();
            if (guidelines) {
              event.systemPromptOptions.sections.bryti_operational_guidelines = guidelines;
            }
          } catch {
            event.systemPromptOptions.sections.bryti_operational_guidelines = "Operational guidelines are unavailable. Do not assume standing authorization; request explicit approval for elevated actions.";
          }
        });
      } },
      { name: "bryti-provider-diagnostics", factory: createProviderDiagnosticsExtension(diagnostics) },
    ],
    extensionsOverride: (base) => {
      extensionToolNames.clear();
      for (const extension of base.extensions) {
        if (extension.path === "<inline:bryti-tool-search>") {
          continue;
        }
        for (const [name, registered] of extension.tools) {
          // A same-name extension must not make its results eligible for automatic cleanup.
          eligibleContextTools.delete(name);
          if (config.google?.users && Object.hasOwn(config.google.users, userId) && GOOGLE_TOOL_NAMES.has(name)) {
            // Explicit native-account opt-in must never leave the legacy shared-token tools reachable.
            extension.tools.delete(name);
            continue;
          }
          // Only definitions captured from the SDK factory bypass agent-written extension policy.
          if (trustedCodemodeDefinitions.has(registered.definition) || trustedSessionDefinitions.has(registered.definition)) {
            continue;
          }
          const definition = toolPolicy.protect(registered.definition, extension.path);
          extension.tools.set(name, { ...registered, definition });
          if (definition.exposure !== "hidden") {
            extensionToolNames.add(name);
          }
        }
      }
      return base;
    },
    settingsManager: createBrytiSettingsManager(config, config.data_dir, agentDir),
    systemPromptOverride: () => {
      // Expire projections older than 24 hours before injecting them into the
      // system prompt. Stale projections must be cleared first so the agent
      // never reasons about items that have clearly passed — seeing expired
      // events would cause it to act on outdated information.
      projectionStore.autoExpire(24);
      const upcoming = projectionStore.getUpcoming(7);
      const projectionText = formatProjectionsForPrompt(upcoming);
      return buildSystemPrompt(
        config,
        coreMemory.read(),
        promptTools,
        extensionToolNames,
        projectionText,
        { isNewUser },
      );
    },
  });
  await loader.reload();

  const settingsManager = createBrytiSettingsManager(config, config.data_dir, agentDir);
  settingsManager.applyOverrides({ defaultTools: ["+codemode"] });

  // --- 3. Session creation + extension loading ---
  const { session, extensionsResult } = await createAgentSession({
    cwd: config.data_dir,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: config.agent.thinking_level,
    customTools: sessionTools,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
  });
  await session.bindExtensions({
    uiContext: {
      ...session.extensionRunner.createContext().ui,
      notify: (message, level) => console.log(`[extensions:${level ?? "info"}] ${message}`),
    },
    onError: (error) => console.error(`[extensions] ${error.extensionPath}: ${error.error}`),
  });
  // Log extension loading results
  if (extensionsResult.extensions.length > 0) {
    for (const extension of extensionsResult.extensions) {
      const toolNames = [...extension.tools.keys()];
      console.log(`[extensions] Loaded: ${extension.path} (tools: ${toolNames.join(", ") || "none"})`);
    }
    console.log(`[extensions] ${extensionsResult.extensions.length} extension(s) loaded, ${extensionToolNames.size} tool(s) registered`);
  }
  if (extensionsResult.errors.length > 0) {
    for (const err of extensionsResult.errors) {
      console.error(`[extensions] Failed to load ${err.path}: ${err.error}`);
    }
  }

  // Native discovery persists activation through the SDK's canonical loadout changes.
  // Repair is applied by the context extension after each canonical projection.
  repairSessionTranscript(session, userId);

  // --- 6. Event subscription setup ---
  // Subscribe to session events for compaction telemetry and the tool-call
  // audit log. The unsubscribe handle is returned via dispose() so callers
  // can clean up without touching the session file.
  const logsDir = path.join(config.data_dir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const toolCallLogPath = path.join(logsDir, "tool-calls.jsonl");
  const compactionLogPath = path.join(logsDir, "compactions.jsonl");

  function appendCompactionLog(entry: Record<string, unknown>): void {
    try {
      fs.appendFileSync(compactionLogPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        userId,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        ...entry,
      }) + "\n", "utf-8");
    } catch {
      // Best-effort telemetry only.
    }
  }

  // Log compaction and tool call events
  let userSessionRef: UserSession | null = null;
  let compactionStartedAt: number | null = null;
  const toolCallCounts = new Map<string, number>();
  const trackTopicDelivery = createTopicDeliveryTracker(config, userId, sessionKey);
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    diagnostics.event(event);
    if (userSessionRef && !isSessionTurnReserved(userSessionRef) && event.type === "entry_appended" &&
      (event.entry.type === "usage" || event.entry.type === "compaction" || event.entry.type === "branch_summary")) {
      const usage = collectSessionUsage(config, [event.entry]);
      if (usage.usage_operations > 0) {
        createUsageTracker(config.data_dir).append({ user_id: userId, kind: "maintenance",
          model: usage.models[0]?.model ?? "auxiliary", latency_ms: 0, ...usage })
          .catch(() => { console.warn("[usage] Unable to record maintenance accounting"); });
      }
    }
    try {
      trackTopicDelivery(event);
    } catch (error) {
      console.error(`[topic-delivery] Failed to preserve destination context for ${sessionKey}:`, error);
    }
    if (event.type === "compaction_start") {
      compactionStartedAt = Date.now();
      console.log(`[compaction] starting (reason: ${event.reason}) for user ${userId}`);
      appendCompactionLog({
        phase: "start",
        reason: event.reason,
        messageCount: session.messages.length,
        contextUsage: session.getContextUsage(),
        model: session.model ? `${session.model.provider}/${session.model.id}` : null,
      });
    } else if (event.type === "compaction_end") {
      if (event.result) {
        const summary = event.result.summary;
        console.log(
          `[compaction] done for user ${userId}: ` +
          `tokensBefore=${event.result.tokensBefore} ` +
          `summaryLength=${summary.length}`,
        );
        appendCompactionLog({
          phase: "end",
          success: true,
          reason: event.reason,
          durationMs: compactionStartedAt ? Date.now() - compactionStartedAt : null,
          aborted: event.aborted,
          willRetry: event.willRetry,
          tokensBefore: event.result.tokensBefore,
          summaryLength: summary.length,
          messageCount: session.messages.length,
          contextUsage: session.getContextUsage(),
          model: session.model ? `${session.model.provider}/${session.model.id}` : null,
        });
        compactionStartedAt = null;
        userSessionRef?.onCompactionComplete?.();
      } else if (event.errorMessage) {
        appendCompactionLog({
          phase: "end",
          success: false,
          reason: event.reason,
          durationMs: compactionStartedAt ? Date.now() - compactionStartedAt : null,
          aborted: event.aborted,
          willRetry: event.willRetry,
          error: event.errorMessage,
          messageCount: session.messages.length,
          contextUsage: session.getContextUsage(),
          model: session.model ? `${session.model.provider}/${session.model.id}` : null,
        });
        compactionStartedAt = null;
        console.error(`[compaction] failed for user ${userId}: ${event.errorMessage}`);
      }
    } else if (event.type === "tool_execution_start") {
      const name = event.toolName ?? "unknown";
      toolCallCounts.set(name, (toolCallCounts.get(name) ?? 0) + 1);
      console.log(`[tool] ${name} called (total this session: ${toolCallCounts.get(name)})`);

      // Append a structured entry to the audit log. Best-effort: never crash the
      // subscriber if the write fails.
      try {
        const args = event.args;
        const argsSummary = buildArgsSummary(name, args);
        const entry = JSON.stringify({
          timestamp: new Date().toISOString(),
          userId,
          toolName: name,
          args_summary: argsSummary,
        });
        fs.appendFileSync(toolCallLogPath, entry + "\n", "utf-8");
      } catch {
        // Best-effort — never let a log write crash the agent loop
      }
    }
  });

  let disposal: Promise<void> | undefined;
  const userSession: UserSession = {
    session,
    modelRegistry,
    userId,
    sessionDir: sessDir,
    lastUserMessageAt: Date.now(),
    extensionErrors: [
      ...extensionsResult.errors.map((e) => ({
        path: e.path,
        error: String(e.error),
      })),
      ...[...toolPolicy.quarantinedNames].map((toolName) => ({
        path: `tool:${toolName}`,
        error: "Tool quarantined because its schema is not provider-safe",
      })),
    ],
    projectionStore,
    dispose() {
      if (!disposal) {
        disposal = (async () => {
          try {
            await session.abort();
          } finally {
            try {
              await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            } finally {
              unsubscribe();
              diagnostics.close();
              session.dispose();
              if (!existingProjectionStore) {
                projectionStore.close();
              }
            }
          }
        })();
      }
      return disposal;
    },
  };
  userSessionRef = userSession;
  return userSession;
}

/**
 * Run transcript repair on the session's messages before prompting.
 * Catches pairing issues from the previous turn (partial writes, races).
 */
export function repairSessionTranscript(session: AgentSession, userId: string): void {
  session.refreshContext();
  const messages = session.messages;
  const report = repairToolUseResultPairing(messages);
  if (report.changed) {
    console.log(
      `Transcript repair pre-prompt for user ${userId}: ` +
      `added=${report.added.length} ` +
      `droppedDuplicates=${report.droppedDuplicateCount} ` +
      `droppedOrphans=${report.droppedOrphanCount}`,
    );
  }
}



/**
 * Result of a prompt attempt in the fallback chain.
 */
interface FallbackResult {
  /** The model string that ultimately succeeded. */
  modelUsed: string;
  /** Number of models tried before success (0 = primary succeeded). */
  fallbacksUsed: number;
}

/**
 * Detect whether pi gave up on a prompt.
 *
 * Two failure modes exist:
 *
 *   1. Thrown error — the SDK exhausted its retry budget and threw. This
 *      covers network failures, timeouts, and provider outages.
 *
 *   2. Last assistant message has stopReason "error" — the model returned a
 *      response the SDK classified as a hard failure (for example a
 *      content-filter block or an internal model error). No exception is
 *      thrown in this case; the bad message is simply appended to the transcript.
 *
 * Both cases mean "try the next model" in the fallback chain.
 */
function didPromptFail(
  session: AgentSession,
  thrownError: unknown,
): { failed: boolean; reason: string } {
  if (thrownError) {
    const msg = thrownError instanceof Error ? thrownError.message : String(thrownError);
    return { failed: true, reason: msg };
  }

  const lastAssistant = session.messages
    .filter((m: AgentMessage) => m.role === "assistant")
    .pop() as Record<string, unknown> | undefined;

  if (lastAssistant?.stopReason === "error") {
    return {
      failed: true,
      reason: String(lastAssistant.errorMessage ?? "model error"),
    };
  }

  return { failed: false, reason: "" };
}

/**
 * Send a prompt, trying the primary model first then each fallback in order.
 *
 * On failure the session's model is switched via setModel() so the persistent
 * session file stays intact. Throws the last error if all candidates fail.
 */
export async function promptWithFallback(
  session: AgentSession,
  text: string,
  config: Config,
  modelRegistry: ModelRegistry,
  userId: string,
  images?: Array<{ data: string; mimeType: string }>,
  controls?: { shouldContinue: () => boolean },
): Promise<FallbackResult> {
  const candidates = [config.agent.model, ...(config.agent.fallback_models ?? [])];
  let lastError: unknown;

  // Convert to SDK ImageContent format
  const imageContent = images?.map((img) => ({
    type: "image" as const,
    data: img.data,
    mimeType: img.mimeType,
  }));

  if (imageContent && imageContent.length > 0) {
    console.log(
      `[images] Sending ${imageContent.length} image(s) to model for user ${userId}: ` +
      imageContent.map((img) => `${img.mimeType} (${Math.round(img.data.length * 0.75 / 1024)}KB base64)`).join(", "),
    );
  }

  for (let i = 0; i < candidates.length; i++) {
    if (controls && !controls.shouldContinue()) {
      throw new Error("Prompt cancelled after watchdog timeout");
    }
    if (session.isStreaming) {
      throw new Error("Agent is already processing; concurrent prompts must share the session queue");
    }
    const modelString = candidates[i];
    const model = resolveModel(modelString, modelRegistry);
    if (!model) {
      console.warn(`Model not found in registry, skipping: ${modelString}`);
      continue;
    }

    // Restore the primary on a new request, including sessions saved on a fallback.
    if (session.model?.provider !== model.provider || session.model?.id !== model.id) {
      console.log(`[fallback] Switching to model ${modelString} for user ${userId}`);
      await session.setModel(model);
    }
    if (controls && !controls.shouldContinue()) {
      throw new Error("Prompt cancelled after watchdog timeout");
    }

    let thrownError: unknown = null;
    try {
      await session.prompt(text, imageContent ? { images: imageContent } : undefined);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Agent is already processing")) {
        throw err;
      }
      thrownError = err;
    }
    if (controls && !controls.shouldContinue()) {
      throw new Error("Prompt cancelled after watchdog timeout");
    }

    const { failed, reason } = didPromptFail(session, thrownError);

    if (!failed) {
      if (i > 0) {
        console.log(`[fallback] Succeeded with model ${modelString} for user ${userId}`);
      }
      return { modelUsed: modelString, fallbacksUsed: i };
    }

    lastError = thrownError ?? new Error(reason);
    console.warn(
      `[fallback] Model ${modelString} failed for user ${userId}: ${reason}` +
      (i < candidates.length - 1 ? ", trying next..." : ", all models exhausted"),
    );
  }

  throw lastError ?? new Error("All models in fallback chain failed");
}

/** Refresh canonical context without rebuilding extensions; prompt sections read live state before each run. */
export async function refreshSystemPrompt(session: AgentSession): Promise<void> {
  session.refreshContext();
}

// Re-export AgentSession type for callers that need it
export type { AgentSession };
