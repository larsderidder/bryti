import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { exec } from "child_process";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

// All shell commands run inside the agent's file workspace, consistent with
// file tools (read_file, write_file, list_directory). This prevents the agent
// from reaching outside data/files/ via the shell while the file tools enforce
// the same boundary via path traversal checks.
const WORKSPACE = path.resolve(
  process.env.BRYTI_DATA_DIR ?? "./data",
  "files",
);

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "shell_exec",
    label: "Shell Command",
    description:
      "Execute a shell command inside the agent workspace and return the output. " +
      "The working directory is the agent's file workspace (same as file tools).",
    parameters: Type.Object({
      command: Type.String({ description: "The shell command to execute" }),
    }),
    async execute(_toolCallId, { command }) {
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 30000,
          cwd: WORKSPACE,
        });
        return {
          content: [{ type: "text", text: stdout || stderr || "(no output)" }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
        };
      }
    },
  });
}
