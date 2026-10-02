import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentSessionEvent, ExtensionFactory, ProviderStreamEvent } from "@earendil-works/pi-coding-agent";

export interface DiagnosticsConfig {
  capture_provider: boolean;
  max_file_bytes: number;
}

/** Never persist arbitrary provider discriminants, text, headers, bodies, or error messages. */
const PROVIDER_EVENT_TYPES = new Set([
  "message_start", "message_stop", "message_delta", "content_block_start", "content_block_delta", "content_block_stop",
  "response.created", "response.completed", "response.failed", "response.incomplete", "response.output_text.delta",
  "response.output_item.added", "response.output_item.done", "response.function_call_arguments.delta", "error", "ping",
]);

/** Bound metadata labels independently of model/tool payloads. */
function label(value: string | undefined): string | null {
  if (value && /^[a-zA-Z0-9_:/|.-]{1,200}$/.test(value)) {
    return value;
  }
  return null;
}

/** A private rotating log with a single retained predecessor. Writes never affect agent execution. */
export function createDiagnosticWriter(dataDir: string, maxBytes = 5 * 1024 * 1024) {
  const directory = path.join(dataDir, "logs");
  const file = path.join(directory, "diagnostics.jsonl");
  return (record: Record<string, unknown>): void => {
    let fd: number | undefined;
    try {
      const line = JSON.stringify(record) + "\n";
      if (Buffer.byteLength(line) > Math.min(maxBytes, 16 * 1024)) {
        return;
      }
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryStat = fs.lstatSync(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        return;
      }
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) {
        return;
      }
      fs.fchmodSync(fd, 0o600);
      if (stat.size + Buffer.byteLength(line) > maxBytes) {
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(file, file + ".1");
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
          fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      }
      fs.writeSync(fd, line);
    } catch {
      // Telemetry is best effort, including full disks and unsafe paths.
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Do not surface cleanup errors from a best effort log.
        }
      }
    }
  };
}

/** Correlate lifecycle and nested tools without recording conversation or tool payloads. */
export function createSessionDiagnostics(params: {
  userId: string;
  sessionId: string;
  sessionKey: string;
  captureProvider?: boolean;
  write: (record: Record<string, unknown>) => void;
}) {
  let runId = crypto.randomUUID();
  let running = false;
  let emitted = 0;
  const tools = new Map<string, { startedAt: number; name: string; parent?: string }>();
  let sampledEvents = 0;
  let droppedEvents = 0;
  let totalSampled = 0;
  let droppedRecords = 0;
  let requestStartedAt: number | undefined;
  let provider: Record<string, unknown> = {};
  let eventCounts: Record<string, number> = Object.create(null);
  let compactionStartedAt: number | undefined;
  let standaloneCompaction = false;

  function beginRun(): void {
    runId = crypto.randomUUID();
    emitted = 0;
    droppedRecords = 0;
    totalSampled = 0;
    running = true;
  }

  function write(record: Record<string, unknown>, final = false): void {
    if (emitted >= 2000 || (emitted >= 1999 && !final)) {
      droppedRecords++;
      return;
    }
    emitted++;
    try {
      params.write({ timestamp: new Date().toISOString(), user_id: params.userId, session_id: params.sessionId,
        session_key: params.sessionKey, run_id: runId, ...record });
    } catch {
      // Broken telemetry must never abort the agent.
    }
  }

  function flushProvider(): void {
    if (sampledEvents > 0 || droppedEvents > 0) {
      write({ type: "provider_stream_summary", ...provider, sampled_events: sampledEvents, dropped_events: droppedEvents, event_counts: eventCounts });
    }
    sampledEvents = 0;
    droppedEvents = 0;
    eventCounts = Object.create(null);
  }

  function close(reason = "disposed"): void {
    for (const [id, tool] of tools) {
      write({ type: "tool_execution_end", tool_call_id: label(id), tool_name: label(tool.name),
        parent_tool_call_id: label(tool.parent), outcome: "unknown", duration_ms: Math.max(0, Date.now() - tool.startedAt) });
    }
    tools.clear();
    flushProvider();
    running = false;
    write({ type: "diagnostics_closed", reason, dropped_records: droppedRecords }, true);
  }

  return {
    close,
    workerState(state: string, queueWaitMs?: number): void {
      write({ type: "worker_state", state: label(state), queue_wait_ms: queueWaitMs });
    },
    request(model: { provider: string; id: string; api: string } | undefined): void {
      if (!params.captureProvider) {
        return;
      }
      flushProvider();
      requestStartedAt = Date.now();
      provider = { provider: label(model?.provider), model: label(model?.id), api: label(model?.api) };
      write({ type: "provider_request", ...provider });
    },
    response(status: number): void {
      if (!params.captureProvider) {
        return;
      }
      let latency: number | null = null;
      if (requestStartedAt !== undefined) {
        latency = Math.max(0, Date.now() - requestStartedAt);
      }
      write({ type: "provider_response", ...provider, status, headers_latency_ms: latency });
    },
    event(event: AgentSessionEvent): void {
      if (event.type === "agent_start") {
        if (!running) {
          beginRun();
        }
        write({ type: event.type });
      } else if (event.type === "tool_execution_start") {
        if (tools.size < 1024) {
          tools.set(event.toolCallId, { startedAt: Date.now(), name: event.toolName, parent: event.parentToolCallId });
        }
        write({ type: event.type, tool_call_id: label(event.toolCallId), tool_name: label(event.toolName),
          parent_tool_call_id: label(event.parentToolCallId) });
      } else if (event.type === "tool_execution_end") {
        const tool = tools.get(event.toolCallId);
        tools.delete(event.toolCallId);
        let duration: number | null = null;
        if (tool) {
          duration = Math.max(0, Date.now() - tool.startedAt);
        }
        let outcome = "success";
        if (event.isError) {
          outcome = "error";
        }
        write({ type: event.type, tool_call_id: label(event.toolCallId), tool_name: label(event.toolName),
          parent_tool_call_id: label(event.parentToolCallId ?? tool?.parent), outcome, duration_ms: duration });
      } else if (event.type === "agent_end") {
        write({ type: event.type, will_retry: event.willRetry });
      } else if (event.type === "agent_settled") {
        write({ type: event.type });
        close("settled");
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        write({ type: "model_response", provider: label(event.message.provider), model: label(event.message.model),
          stop_reason: label(event.message.stopReason) });
      } else if (event.type === "queue_update") {
        write({ type: event.type, steering_count: event.steering.length, follow_up_count: event.followUp.length });
      } else if (event.type === "auto_retry_start") {
        write({ type: event.type, attempt: event.attempt, delay_ms: event.delayMs });
      } else if (event.type === "auto_retry_end") {
        write({ type: event.type, attempt: event.attempt, success: event.success });
      } else if (event.type === "turn_start" || event.type === "turn_end") {
        write({ type: event.type });
      } else if (event.type === "compaction_start") {
        standaloneCompaction = !running;
        if (standaloneCompaction) {
          beginRun();
        }
        compactionStartedAt = Date.now();
        write({ type: event.type, reason: event.reason });
      } else if (event.type === "compaction_end") {
        let duration: number | null = null;
        if (compactionStartedAt !== undefined) {
          duration = Math.max(0, Date.now() - compactionStartedAt);
        }
        write({ type: event.type, reason: event.reason, duration_ms: duration, aborted: event.aborted,
          will_retry: event.willRetry, has_error: Boolean(event.errorMessage) });
        if (standaloneCompaction) {
          close("compaction");
        }
        compactionStartedAt = undefined;
        standaloneCompaction = false;
      }
    },
    providerEvent(event: Pick<ProviderStreamEvent, "provider" | "api" | "model" | "data">): void {
      if (!params.captureProvider || !running) {
        return;
      }
      if (totalSampled >= 200) {
        droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, droppedEvents + 1);
        return;
      }
      sampledEvents++;
      totalSampled++;
      provider = { provider: label(event.provider), api: label(event.api), model: label(event.model) };
      let type = "other";
      if (event.data && typeof event.data === "object" && "type" in event.data &&
        typeof event.data.type === "string" && PROVIDER_EVENT_TYPES.has(event.data.type)) {
        type = event.data.type;
      }
      eventCounts[type] = (eventCounts[type] ?? 0) + 1;
    },
    steering(disposition: "queued" | "handled"): void {
      write({ type: "steering", disposition });
    },
  };
}

/** Observe provider events without persisting or modifying raw provider values. */
export function createProviderDiagnosticsExtension(
  diagnostics: ReturnType<typeof createSessionDiagnostics>,
): ExtensionFactory {
  return (pi) => {
    pi.on("provider_stream_event", diagnostics.providerEvent);
    pi.on("before_provider_request", (_event, ctx) => { diagnostics.request(ctx.model); });
    pi.on("after_provider_response", (event) => { diagnostics.response(event.status); });
  };
}
