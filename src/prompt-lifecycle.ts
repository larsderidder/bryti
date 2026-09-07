export const PROMPT_INACTIVITY_TIMEOUT_MS = 6 * 60 * 1000;

export type PromptWatchdogControls = {
  shouldContinue: () => boolean;
};

export type PromptWatchdogResult<T> =
  | { status: "completed"; value: T }
  | { status: "timeout" };

type PromptWatchdogParams<T> = {
  sessionKey: string;
  timeoutMs?: number;
  subscribe: (listener: () => void) => () => void;
  abort: () => Promise<void>;
  operation: (controls: PromptWatchdogControls) => Promise<T>;
  onInactive?: (sessionKey: string, timeoutMs: number) => void;
  onAbortError?: (sessionKey: string, error: unknown) => void;
  onLateRejection?: (sessionKey: string, error: unknown) => void;
};

/**
 * Run a prompt and abort it only when the agent loop has been inactive for the
 * configured interval. Activity events re-arm the timer. Cleanup always runs,
 * even when the prompt rejects before the timer fires.
 */
export async function runPromptWithActivityWatchdog<T>(
  params: PromptWatchdogParams<T>,
): Promise<PromptWatchdogResult<T>> {
  const timeoutMs = params.timeoutMs ?? PROMPT_INACTIVITY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let timedOut = false;
  let operationPromise: Promise<T> | null = null;
  let resolveTimeout!: (result: PromptWatchdogResult<T>) => void;

  const timeoutPromise = new Promise<PromptWatchdogResult<T>>((resolve) => {
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
    if (settled) {
      return;
    }
    clearTimer();
    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      params.onInactive?.(params.sessionKey, timeoutMs);
      void params.abort().catch((err) => {
        params.onAbortError?.(params.sessionKey, err);
      });
      resolveTimeout({ status: "timeout" });
    }, timeoutMs);
  };

  const unsubscribe = params.subscribe(() => {
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
