/**
 * Application logging: structured JSONL file logger and console interceptor.
 *
 * Two things live here:
 *
 * 1. createAppLogger — writes structured JSONL entries to daily log files
 *    under data/logs/. Each file is named YYYY-MM-DD.jsonl and contains one
 *    JSON object per line with timestamp, level, message, and optional args.
 *    Log rotation is automatic (new file per calendar day). Old files are
 *    never cleaned up automatically.
 *    TODO: add a cleanup pass that deletes log files older than N days.
 *
 * 2. installConsoleFileLogging — replaces console.log/info/warn/error/debug
 *    with interceptors that (a) write a formatted, timestamped line to the
 *    appropriate stdio stream, and (b) mirror the entry to the JSONL file
 *    logger. After installation, all console.* output goes to both the
 *    terminal and the daily log file simultaneously.
 */

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

// Guard flag: prevents installConsoleFileLogging from double-wrapping the
// console methods if called more than once (e.g., in tests or after a reload).
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
 * ANSI color codes are only emitted when the target stream is a TTY. When
 * stdout/stderr is piped (e.g., to a file or another process), isTTY is
 * false and the output stays plain text without escape sequences.
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
 * Intercept console.* calls to write timestamped lines to stdio and mirror
 * them to the JSONL file logger. Replaces the raw methods permanently.
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
