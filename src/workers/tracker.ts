import fs from "node:fs";
import path from "node:path";
import type { AgentSession, AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { createSessionDiagnostics } from "../session-diagnostics.js";
import { writeJsonAtomic } from "../durable-file.js";

export interface WorkerProgress {
  turns_started: number;
  turns_completed: number;
  active_tools: number;
  tool_calls_total: number;
  tool_calls_by_name: Record<string, number>;
  tool_errors: number;
  last_tool: string | null;
  last_activity_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  context_tokens: number | null;
  context_window: number | null;
  context_percent: number | null;
  stop_reason: string | null;
  wrap_up_sent: boolean;
}

export interface WorkerRuntimePaths {
  transcript_path: string;
  output_path: string;
}

export interface WorkerRunTracker {
  progress: WorkerProgress;
  paths: WorkerRuntimePaths;
  unsubscribe: () => void;
  writeOutput(status: string, details?: Record<string, unknown>): void;
  recordSteering(disposition: "queued" | "handled"): void;
}

type StatusWriter = (progress: WorkerProgress, paths: WorkerRuntimePaths) => void;

function emptyProgress(): WorkerProgress {
  return {
    turns_started: 0,
    turns_completed: 0,
    active_tools: 0,
    tool_calls_total: 0,
    tool_calls_by_name: Object.create(null),
    tool_errors: 0,
    last_tool: null,
    last_activity_at: new Date().toISOString(),
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
    context_tokens: null,
    context_window: null,
    context_percent: null,
    stop_reason: null,
    wrap_up_sent: false,
  };
}

function addUsage(progress: WorkerProgress, usage: Usage | undefined): void {
  if (!usage) {
    return;
  }
  function amount(value: number | undefined): number {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
    return 0;
  }
  progress.input_tokens += amount(usage.input);
  progress.output_tokens += amount(usage.output);
  progress.cache_read_tokens += amount(usage.cacheRead);
  progress.cache_write_tokens += amount(usage.cacheWrite);
  progress.cost_usd += amount(usage.cost?.total);
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

function appendTranscript(workerDir: string, event: AgentSessionEvent): void {
  const transcriptPath = path.join(workerDir, "transcript.jsonl");
  const base: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    type: event.type,
  };

  if (event.type === "message_end") {
    const message = event.message as unknown as Record<string, unknown>;
    base.role = message.role;
    base.stop_reason = message.stopReason;
    if (message.usage && typeof message.usage === "object") {
      const usage = message.usage as Usage;
      base.usage = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        cost: { total: usage.cost?.total } };
    }
  } else if (event.type === "tool_execution_start") {
    base.tool_call_id = event.toolCallId;
    base.tool_name = event.toolName;
    base.parent_tool_call_id = event.parentToolCallId;
  } else if (event.type === "tool_execution_end") {
    base.tool_call_id = event.toolCallId;
    base.tool_name = event.toolName;
    base.is_error = event.isError;
    base.parent_tool_call_id = event.parentToolCallId;
  } else if (event.type === "turn_end") {
    base.tool_results = event.toolResults.length;
  } else if (event.type === "agent_end") {
    base.will_retry = event.willRetry;
  } else if (event.type === "compaction_end") {
    base.reason = event.reason;
    base.aborted = event.aborted;
    base.will_retry = event.willRetry;
    base.has_error = Boolean(event.errorMessage);
  }

  try {
    fs.appendFileSync(transcriptPath, jsonLine(base), "utf-8");
  } catch {
    // Best effort only. Status tracking must not fail the worker.
  }
}

function updateContext(progress: WorkerProgress, session: AgentSession): void {
  const usage = session.getContextUsage?.();
  if (!usage) return;
  progress.context_tokens = usage.tokens;
  progress.context_window = usage.contextWindow;
  progress.context_percent = usage.percent;
}

function maybeSteerWrapUp(params: {
  session: AgentSession;
  progress: WorkerProgress;
  maxTurns: number | undefined;
  recordSteering: (disposition: "queued" | "handled") => void;
}): void {
  const { session, progress, maxTurns, recordSteering } = params;
  if (!maxTurns || maxTurns <= 1) return;
  if (progress.wrap_up_sent) return;
  if (progress.turns_completed < maxTurns - 1) return;

  progress.wrap_up_sent = true;
  void session.steer(
    "You are near the worker turn limit. Stop gathering new material now. " +
    "Synthesize what you have, write the final answer to result.md, and then finish.",
  ).then((disposition) => {
    recordSteering(disposition);
  }).catch((err: unknown) => {
    console.warn(`[worker] failed to send max-turn wrap-up steering: ${(err as Error).message}`);
  });
}

/** Recover cumulative budgets and evidence from the SDK's authoritative conversation. */
export function recoverWorkerProgress(entries: SessionEntry[], previous?: WorkerProgress): WorkerProgress {
  const progress = emptyProgress();
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant") {
        progress.turns_started++;
        progress.turns_completed++;
        addUsage(progress, message.usage);
      } else if (message.role === "toolResult") {
        progress.tool_calls_total++;
        progress.tool_calls_by_name[message.toolName] = (progress.tool_calls_by_name[message.toolName] ?? 0) + 1;
        addUsage(progress, message.usage);
      }
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      addUsage(progress, entry.usage);
    }
  }
  if (previous) {
    progress.turns_started = Math.max(progress.turns_started, previous.turns_started);
    progress.turns_completed = Math.max(progress.turns_completed, previous.turns_completed);
    progress.tool_calls_total = Math.max(progress.tool_calls_total, previous.tool_calls_total);
    progress.wrap_up_sent = previous.wrap_up_sent;
    for (const [name, count] of Object.entries(previous.tool_calls_by_name)) {
      progress.tool_calls_by_name[name] = Math.max(progress.tool_calls_by_name[name] ?? 0, count);
    }
  }
  return progress;
}

export function attachWorkerRunTracker(params: {
  session: AgentSession;
  workerDir: string;
  maxTurns?: number;
  writeStatus: StatusWriter;
  diagnostics?: ReturnType<typeof createSessionDiagnostics>;
  initialProgress?: WorkerProgress;
  onUserEntry?: (text: string, timestamp: number) => void;
}): WorkerRunTracker {
  const { session, workerDir, maxTurns, writeStatus } = params;
  const progress = { ...emptyProgress(), ...params.initialProgress,
    tool_calls_by_name: { ...params.initialProgress?.tool_calls_by_name }, active_tools: 0 };
  const paths: WorkerRuntimePaths = {
    transcript_path: path.join(workerDir, "transcript.jsonl"),
    output_path: path.join(workerDir, "output.json"),
  };
  const activeCalls = new Set<string>();
  function recordSteering(disposition: "queued" | "handled"): void {
    params.diagnostics?.steering(disposition);
    try {
      fs.appendFileSync(paths.transcript_path, jsonLine({ timestamp: new Date().toISOString(), type: "steering", disposition }), { mode: 0o600 });
    } catch {
      // Best effort telemetry only.
    }
  }

  const handleEvent = (event: AgentSessionEvent): void => {
    params.diagnostics?.event(event);
    progress.last_activity_at = new Date().toISOString();
    appendTranscript(workerDir, event);

    if (event.type === "turn_start") {
      progress.turns_started++;
    } else if (event.type === "turn_end") {
      progress.turns_completed++;
      maybeSteerWrapUp({ session, progress, maxTurns, recordSteering });
    } else if (event.type === "message_end") {
      const message = event.message as unknown as Record<string, any>;
      if (message.role === "assistant" || message.role === "toolResult") {
        addUsage(progress, message.usage as Usage | undefined);
      }
      if (message.role === "assistant" && typeof message.stopReason === "string") {
        progress.stop_reason = message.stopReason;
      }
    } else if (event.type === "entry_appended") {
      const entry = event.entry;
      if (entry.type === "message" && entry.message.role === "user" && typeof entry.message.content === "string") {
        params.onUserEntry?.(entry.message.content, entry.message.timestamp);
      }
      if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
        addUsage(progress, entry.usage);
      }
    } else if (event.type === "tool_execution_start") {
      activeCalls.add(event.toolCallId);
      progress.active_tools = activeCalls.size;
      progress.tool_calls_total++;
      progress.last_tool = event.toolName;
      progress.tool_calls_by_name[event.toolName] = (progress.tool_calls_by_name[event.toolName] ?? 0) + 1;
    } else if (event.type === "tool_execution_end") {
      activeCalls.delete(event.toolCallId);
      progress.active_tools = activeCalls.size;
      if (event.isError) progress.tool_errors++;
      progress.last_tool = event.toolName;
    } else if (event.type === "compaction_end") {
      progress.stop_reason = event.aborted ? "compaction_aborted" : progress.stop_reason;
    }

    updateContext(progress, session);
    writeStatus(progress, paths);
  };

  const unsubscribe = session.subscribe(handleEvent);

  return {
    progress,
    paths,
    unsubscribe,
    recordSteering,
    writeOutput(status, details = {}) {
      try {
        writeJsonAtomic(paths.output_path, {
          status, completed_at: new Date().toISOString(), progress, ...details,
        });
      } catch {
        // Best effort only.
      }
    },
  };
}
