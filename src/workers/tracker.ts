import fs from "node:fs";
import path from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

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
}

type StatusWriter = (progress: WorkerProgress, paths: WorkerRuntimePaths) => void;

function emptyProgress(): WorkerProgress {
  return {
    turns_started: 0,
    turns_completed: 0,
    active_tools: 0,
    tool_calls_total: 0,
    tool_calls_by_name: {},
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
  if (!usage) return;
  progress.input_tokens += usage.input ?? 0;
  progress.output_tokens += usage.output ?? 0;
  progress.cache_read_tokens += usage.cacheRead ?? 0;
  progress.cache_write_tokens += usage.cacheWrite ?? 0;
  progress.cost_usd += usage.cost?.total ?? 0;
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
    base.usage = message.usage;
  } else if (event.type === "tool_execution_start") {
    base.tool_call_id = event.toolCallId;
    base.tool_name = event.toolName;
    base.args = event.args;
  } else if (event.type === "tool_execution_end") {
    base.tool_call_id = event.toolCallId;
    base.tool_name = event.toolName;
    base.is_error = event.isError;
  } else if (event.type === "turn_end") {
    base.tool_results = event.toolResults.length;
  } else if (event.type === "agent_end") {
    base.will_retry = event.willRetry;
  } else if (event.type === "compaction_end") {
    base.reason = event.reason;
    base.aborted = event.aborted;
    base.will_retry = event.willRetry;
    base.error_message = event.errorMessage;
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
}): void {
  const { session, progress, maxTurns } = params;
  if (!maxTurns || maxTurns <= 1) return;
  if (progress.wrap_up_sent) return;
  if (progress.turns_completed < maxTurns - 1) return;

  progress.wrap_up_sent = true;
  void session.steer(
    "You are near the worker turn limit. Stop gathering new material now. " +
    "Synthesize what you have, write the final answer to result.md, and then finish.",
  ).catch((err: unknown) => {
    console.warn(`[worker] failed to send max-turn wrap-up steering: ${(err as Error).message}`);
  });
}

export function attachWorkerRunTracker(params: {
  session: AgentSession;
  workerDir: string;
  maxTurns?: number;
  writeStatus: StatusWriter;
}): WorkerRunTracker {
  const { session, workerDir, maxTurns, writeStatus } = params;
  const progress = emptyProgress();
  const paths: WorkerRuntimePaths = {
    transcript_path: path.join(workerDir, "transcript.jsonl"),
    output_path: path.join(workerDir, "output.json"),
  };

  const handleEvent = (event: AgentSessionEvent): void => {
    progress.last_activity_at = new Date().toISOString();
    appendTranscript(workerDir, event);

    if (event.type === "turn_start") {
      progress.turns_started++;
    } else if (event.type === "turn_end") {
      progress.turns_completed++;
      maybeSteerWrapUp({ session, progress, maxTurns });
    } else if (event.type === "message_end") {
      const message = event.message as unknown as Record<string, any>;
      if (message.role === "assistant") {
        addUsage(progress, message.usage as Usage | undefined);
        progress.stop_reason = typeof message.stopReason === "string" ? message.stopReason : progress.stop_reason;
      }
    } else if (event.type === "tool_execution_start") {
      progress.active_tools++;
      progress.tool_calls_total++;
      progress.last_tool = event.toolName;
      progress.tool_calls_by_name[event.toolName] = (progress.tool_calls_by_name[event.toolName] ?? 0) + 1;
    } else if (event.type === "tool_execution_end") {
      progress.active_tools = Math.max(0, progress.active_tools - 1);
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
    writeOutput(status, details = {}) {
      try {
        fs.writeFileSync(
          paths.output_path,
          JSON.stringify({
            status,
            completed_at: new Date().toISOString(),
            progress,
            ...details,
          }, null, 2),
          "utf-8",
        );
      } catch {
        // Best effort only.
      }
    },
  };
}
