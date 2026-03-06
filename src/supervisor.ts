/**
 * Top-level supervisor loop.
 *
 * Starts the app, catches fatal errors, and restarts automatically after a
 * delay. The loop uses a promise/resolver pattern so signal handlers and
 * uncaught-exception handlers share a single control path.
 *
 * State machine:
 *   - startApp() is called; if it throws immediately, retry after a delay.
 *   - Once running, we wait for either a graceful signal (SIGINT/SIGTERM →
 *     "shutdown") or an unhandled error ("restart").
 *   - On "shutdown" the loop exits cleanly.
 *   - On "restart" the app is stopped and the loop continues.
 */

export interface RunningApp {
  stop(): Promise<void>;
}

function asError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  return new Error(String(reason));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the app under a supervisor that restarts on fatal errors.
 *
 * @param startApp Factory function that creates a running app instance.
 *                 Receives a `requestRestart` callback the app can call to
 *                 trigger a controlled restart from inside (e.g. after writing
 *                 a new extension). The callback resolves the current iteration
 *                 with "restart" without needing an uncaught exception.
 */
export async function runWithSupervisor(
  startApp: (onRequestRestart: () => void) => Promise<RunningApp>,
): Promise<void> {
  const restartDelayMs = Number(process.env.BRYTI_RESTART_DELAY_MS ?? 2000);
  let shutdownRequested = false;
  let resolver: ((outcome: "shutdown" | "restart") => void) | null = null;

  const resolveOutcome = (outcome: "shutdown" | "restart"): void => {
    if (!resolver) {
      return;
    }
    const current = resolver;
    resolver = null;
    current(outcome);
  };

  const onSignal = (): void => {
    shutdownRequested = true;
    resolveOutcome("shutdown");
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  while (!shutdownRequested) {
    let app: RunningApp | undefined;
    let fatalError: Error | undefined;
    try {
      app = await startApp(() => resolveOutcome("restart"));
    } catch (error) {
      fatalError = asError(error);
    }

    if (!app) {
      console.error("Fatal startup error:", fatalError);
      // Don't retry on config errors (missing file, bad YAML, validation).
      // These won't fix themselves between restarts.
      if ((fatalError as any)?.code === "CONFIG_NOT_FOUND" || shutdownRequested) {
        break;
      }
      console.log(`Restarting in ${restartDelayMs}ms...`);
      await sleep(restartDelayMs);
      continue;
    }

    const onUncaughtException = (error: Error): void => {
      fatalError = error;
      resolveOutcome("restart");
    };
    const onUnhandledRejection = (reason: unknown): void => {
      fatalError = asError(reason);
      resolveOutcome("restart");
    };

    process.once("uncaughtException", onUncaughtException);
    process.once("unhandledRejection", onUnhandledRejection);

    const outcome = await new Promise<"shutdown" | "restart">((resolve) => {
      if (shutdownRequested) {
        resolve("shutdown");
        return;
      }
      resolver = resolve;
    });

    process.removeListener("uncaughtException", onUncaughtException);
    process.removeListener("unhandledRejection", onUnhandledRejection);

    await app.stop();

    if (outcome === "shutdown") {
      break;
    }

    console.error("Fatal runtime error:", fatalError);
    if (shutdownRequested) {
      break;
    }
    console.log(`Restarting in ${restartDelayMs}ms...`);
    await sleep(restartDelayMs);
  }

  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
