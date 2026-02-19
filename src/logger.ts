import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { stdout, stderr } from "node:process";

type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  args?: unknown[];
}

export interface AppLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

let consoleFileLoggingInstalled = false;

function toDateString(date: Date): string {
  return date.toISOString().split("T")[0];
}

function toSerializable(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
}

export function createAppLogger(dataDir: string): AppLogger {
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });

  function append(level: LogLevel, message: string, args: unknown[]): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(args.length > 0 ? { args: args.map(toSerializable) } : {}),
    } satisfies LogEntry);

    const filePath = path.join(logsDir, `${toDateString(new Date())}.jsonl`);
    fs.appendFileSync(filePath, `${line}\n`, "utf-8");
  }

  return {
    debug(message: string, ...args: unknown[]): void {
      append("debug", message, args);
    },
    info(message: string, ...args: unknown[]): void {
      append("info", message, args);
    },
    warn(message: string, ...args: unknown[]): void {
      append("warn", message, args);
    },
    error(message: string, ...args: unknown[]): void {
      append("error", message, args);
    },
  };
}

// ---------------------------------------------------------------------------
// Stdio formatting
// ---------------------------------------------------------------------------

/** ANSI color codes, used only when the stream is a TTY. */
const ANSI = {
  reset:  "\x1b[0m",
  dim:    "\x1b[2m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
} as const;

const LEVEL_PREFIX: Record<LogLevel, string> = {
  debug: "DBG",
  info:  "INF",
  warn:  "WRN",
  error: "ERR",
};

/**
 * Format a log line for stdio.
 *
 * Output: `2026-02-18 22:14:27 [WRN] message text`
 *
 * Color is applied only when writing to a TTY so that piped/redirected
 * output stays plain text.
 */
function formatLine(level: LogLevel, message: string, isTty: boolean): string {
  const now = new Date();
  const ts = now.toISOString().slice(0, 19).replace("T", " ");
  const prefix = LEVEL_PREFIX[level];

  if (!isTty) {
    return `${ts} [${prefix}] ${message}`;
  }

  const tsColored = `${ANSI.dim}${ts}${ANSI.reset}`;
  let prefixColored: string;
  if (level === "warn") {
    prefixColored = `${ANSI.yellow}[${prefix}]${ANSI.reset}`;
  } else if (level === "error") {
    prefixColored = `${ANSI.red}[${prefix}]${ANSI.reset}`;
  } else if (level === "debug") {
    prefixColored = `${ANSI.dim}[${prefix}]${ANSI.reset}`;
  } else {
    prefixColored = `${ANSI.cyan}[${prefix}]${ANSI.reset}`;
  }

  return `${tsColored} ${prefixColored} ${message}`;
}

// ---------------------------------------------------------------------------
// Console intercept
// ---------------------------------------------------------------------------

/**
 * Intercept console.* calls to:
 * 1. Write a timestamped, level-prefixed line to stdout/stderr.
 * 2. Mirror the structured entry to the JSONL file logger.
 *
 * After this runs, all console output includes timestamps. The raw
 * console.* methods are replaced permanently for the process lifetime.
 */
export function installConsoleFileLogging(logger: AppLogger): void {
  if (consoleFileLoggingInstalled) {
    return;
  }
  consoleFileLoggingInstalled = true;

  const stdoutTty = stdout.isTTY ?? false;
  const stderrTty = stderr.isTTY ?? false;

  function makeInterceptor(level: LogLevel, stream: NodeJS.WriteStream, isTty: boolean) {
    return (...args: unknown[]): void => {
      const message = util.format(...args);
      // Write formatted line to the appropriate stream
      stream.write(formatLine(level, message, isTty) + "\n");
      // Mirror to JSONL file (message without args duplication)
      logger[level](message);
    };
  }

  console.log   = makeInterceptor("info",  stdout, stdoutTty);
  console.info  = makeInterceptor("info",  stdout, stdoutTty);
  console.debug = makeInterceptor("debug", stdout, stdoutTty);
  console.warn  = makeInterceptor("warn",  stderr, stderrTty);
  console.error = makeInterceptor("error", stderr, stderrTty);
}
