export const PROMPT_INACTIVITY_TIMEOUT_MS = 6 * 60 * 1000;
export const PROMPT_MAX_DURATION_MS = 60 * 60 * 1000;

export type PromptWatchdogControls = {
  shouldContinue: () => boolean;
};

export interface PromptActivity {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
}

export interface PromptTimeout {
  status: "timeout";
  reason: "inactivity" | "tool_deadline" | "prompt_deadline";
  toolName?: string;
  elapsedMs: number;
}

export type PromptWatchdogResult<T> =
  | { status: "completed"; value: T }
  | PromptTimeout;

type PromptWatchdogParams<T> = {
  sessionKey: string;
  timeoutMs?: number;
  maxDurationMs?: number;
  toolGraceMs?: number;
  subscribe: (listener: (event?: PromptActivity) => void) => () => void;
  abort: () => Promise<void>;
  operation: (controls: PromptWatchdogControls) => Promise<T>;
  onInactive?: (sessionKey: string, timeoutMs: number) => void;
  onTimeout?: (sessionKey: string, timeout: PromptTimeout) => void;
  onAbortError?: (sessionKey: string, error: unknown) => void;
  onLateRejection?: (sessionKey: string, error: unknown) => void;
};

/** Keep tool deadlines separate from model silence; neither can extend the turn's hard limit. */
export async function runPromptWithActivityWatchdog<T>(
  params: PromptWatchdogParams<T>,
): Promise<PromptWatchdogResult<T>> {
  const timeoutMs = params.timeoutMs ?? PROMPT_INACTIVITY_TIMEOUT_MS;
  const maxDurationMs = params.maxDurationMs ?? PROMPT_MAX_DURATION_MS;
  const toolGraceMs = params.toolGraceMs ?? 5_000;
  const startedAt = Date.now();
  const hardDeadline = startedAt + maxDurationMs;
  let lastActivityAt = startedAt;
  const tools = new Map<string, { name: string; deadline: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let timedOut = false;
  let operationPromise: Promise<T> | null = null;
  let resolveTimeout!: (result: PromptTimeout) => void;

  const timeoutPromise = new Promise<PromptTimeout>((resolve) => {
    resolveTimeout = resolve;
  });

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const controls: PromptWatchdogControls = {
    shouldContinue: () => !timedOut,
  };

  const armTimer = () => {
    if (settled || timedOut) {
      return;
    }
    clearTimer();
    let deadline = hardDeadline;
    let reason: PromptTimeout["reason"] = "prompt_deadline";
    let toolName: string | undefined;
    if (tools.size > 0) {
      for (const tool of tools.values()) {
        if (tool.deadline < deadline) {
          deadline = tool.deadline;
          reason = "tool_deadline";
          toolName = tool.name;
        }
      }
    } else if (lastActivityAt + timeoutMs < deadline) {
      deadline = lastActivityAt + timeoutMs;
      reason = "inactivity";
    }
    timer = setTimeout(() => {
      if (settled || timedOut) {
        return;
      }
      timedOut = true;
      const result: PromptTimeout = { status: "timeout", reason, toolName, elapsedMs: Date.now() - startedAt };
      if (reason === "inactivity") {
        params.onInactive?.(params.sessionKey, timeoutMs);
      }
      params.onTimeout?.(params.sessionKey, result);
      void Promise.resolve().then(() => params.abort()).catch((err) => {
        params.onAbortError?.(params.sessionKey, err);
      });
      resolveTimeout(result);
    }, Math.max(0, deadline - Date.now()));
  };

  const unsubscribe = params.subscribe((event) => {
    if (settled || timedOut) {
      return;
    }
    lastActivityAt = Date.now();
    if (event?.type === "tool_execution_start" && event.toolCallId && !tools.has(event.toolCallId)) {
      let durationMs = timeoutMs;
      // Only bash's timeout is a known execution contract, not an arbitrary tool argument.
      if (event.toolName === "bash" && event.args && typeof event.args === "object") {
        const seconds = (event.args as { timeout?: unknown }).timeout;
        if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
          durationMs = Math.min(seconds * 1000, maxDurationMs) + toolGraceMs;
        }
      }
      tools.set(event.toolCallId, { name: event.toolName ?? "unknown", deadline: Date.now() + durationMs });
    } else if (event?.type === "tool_execution_end" && event.toolCallId) {
      tools.delete(event.toolCallId);
    }
    armTimer();
  });

  try {
    armTimer();
    operationPromise = params.operation(controls);
    return await Promise.race([
      operationPromise.then((value) => ({ status: "completed", value }) as const),
      timeoutPromise,
    ]);
  } finally {
    settled = true;
    clearTimer();
    unsubscribe();
    if (timedOut && operationPromise) {
      operationPromise.catch((err) => {
        params.onLateRejection?.(params.sessionKey, err);
      });
    }
  }
}

/** Report the timeout without exposing command arguments or claiming child processes stopped. */
export function describePromptTimeout(timeout: PromptTimeout): string {
  if (timeout.reason === "tool_deadline") {
    return `The ${timeout.toolName ?? "active"} tool exceeded its execution deadline.`;
  }
  if (timeout.reason === "prompt_deadline") {
    return "The request reached its overall execution time limit.";
  }
  return "The model stopped producing activity while no tool was running.";
}
