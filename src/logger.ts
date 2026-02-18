import fs from "node:fs";
import path from "node:path";
import util from "node:util";

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

/**
 * Mirror console output to JSONL logs while preserving normal stdout/stderr output.
 */
export function installConsoleFileLogging(logger: AppLogger): void {
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  function forward(level: LogLevel, output: (...args: unknown[]) => void) {
    return (...args: unknown[]): void => {
      const message = util.format(...args);
      logger[level](message, ...args);
      output(...args);
    };
  }

  console.log = forward("info", original.log);
  console.info = forward("info", original.info);
  console.warn = forward("warn", original.warn);
  console.error = forward("error", original.error);
  console.debug = forward("debug", original.debug);
}
