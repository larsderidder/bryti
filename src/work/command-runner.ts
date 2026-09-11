import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { commandProcessIdentity, createCommandStore, type CommandStatus } from "./commands.js";

/** Run once outside the chat session, with bounded output and a deadline for the whole process group. */
export async function runManagedCommand(dataDir: string, id: string, maxOutputBytes = 10 * 1024 * 1024): Promise<void> {
  const store = createCommandStore(dataDir);
  let output: number | undefined;
  try {
    const record = store.get(id);
    const identity = commandProcessIdentity(process.pid);
    if (!record || !identity || !store.claim(id, process.pid, identity)) {
      return;
    }
    fs.mkdirSync(path.dirname(record.logPath), { recursive: true, mode: 0o700 });
    output = fs.openSync(record.logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const fd = output;
    let bytes = 0;
    let truncated = false;
    await new Promise<void>((resolve, reject) => {
      // GNU timeout remains alive if this runner crashes, so the command still has a deadline.
      const child = spawn("/usr/bin/timeout", ["--kill-after=1s", `${record.timeoutSeconds}s`, "/bin/bash", "-c", record.command], {
        cwd: record.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let outcome: Exclude<CommandStatus, "queued" | "running"> | undefined;
      let error: string | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid) {
          try {
            process.kill(-child.pid, signal);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
              error = "Could not confirm command process-group termination";
            }
          }
        }
      };
      const stop = (status: "timeout" | "interrupted" | "failed") => {
        if (outcome) {
          return;
        }
        outcome = status;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), 1000);
      };
      const onSignal = () => stop("interrupted");
      process.once("SIGTERM", onSignal);
      process.once("SIGINT", onSignal);
      const timer = setTimeout(() => stop("timeout"), record.timeoutSeconds * 1000);
      const writeOutput = (data: Buffer) => {
        try {
          const chunk = data.subarray(0, Math.max(0, maxOutputBytes - bytes));
          if (chunk.length) {
            fs.writeSync(fd, chunk);
            bytes += chunk.length;
          }
          if (data.length > chunk.length && !truncated) {
            fs.writeSync(fd, "\n[Command output truncated at the storage limit]\n");
            truncated = true;
          }
        } catch {
          error = "Command output could not be persisted";
          stop("failed");
        }
      };
      child.stdout.on("data", writeOutput);
      child.stderr.on("data", writeOutput);
      child.on("error", () => {
        outcome = "failed";
        error = "Could not start command process";
      });
      child.on("exit", () => {
        // A completed shell must not leave background children holding its pipes open.
        killGroup("SIGKILL");
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
        if (!outcome) {
          outcome = "failed";
          if (code === 0 && !error) {
            outcome = "complete";
          } else if (code === 124) {
            outcome = "timeout";
          }
        }
        try {
          store.finish(id, outcome, code, error);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  } catch {
    store.finish(id, "failed", null, "Command runner could not persist or execute the accepted command");
  } finally {
    if (output !== undefined) {
      fs.closeSync(output);
    }
    store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , dataDir, id] = process.argv;
  if (!dataDir || !path.isAbsolute(dataDir) || !/^c-[a-f0-9]{24}$/.test(id ?? "")) {
    process.exitCode = 1;
  } else {
    await runManagedCommand(dataDir, id);
  }
}
