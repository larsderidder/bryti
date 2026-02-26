/**
 * Bryti Bridge - Allows bryti to inject messages into running pi sessions.
 *
 * Creates a Unix socket at ~/.pi/agent/sockets/<session-id>-<token>.sock
 * that accepts JSON messages. The random token prevents blind connection
 * attempts. Bryti discovers the socket by listing the sockets directory
 * and matching the session ID prefix.
 *
 * Protocol: one JSON object per line (newline-delimited JSON)
 *   Request:  { "type": "user_message", "text": "..." }
 *   Response: { "ok": true } or { "ok": false, "error": "..." }
 */

import * as crypto from "node:crypto";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function socketsDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "sockets");
}

function socketPath(sessionId: string, token: string): string {
  return path.join(socketsDir(), `${sessionId}-${token}.sock`);
}

export default function (pi: ExtensionAPI) {
  let server: net.Server | null = null;
  let currentSocketPath: string | null = null;
  let sendUserMessage: ((text: string) => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;

    sendUserMessage = (text: string) => pi.sendUserMessage(text);

    // Create sockets directory if needed
    const dir = socketsDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Clean up any stale sockets for this session ID
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(sessionId) && f.endsWith(".sock")) {
          try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    const token = crypto.randomBytes(8).toString("hex");
    const sockPath = socketPath(sessionId, token);
    currentSocketPath = sockPath;

    server = net.createServer((conn) => {
      let buffer = "";

      conn.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "user_message" && typeof msg.text === "string" && sendUserMessage) {
              sendUserMessage(msg.text);
              conn.write(JSON.stringify({ ok: true }) + "\n");
            } else {
              conn.write(JSON.stringify({ ok: false, error: "Unknown message type or bridge not ready" }) + "\n");
            }
          } catch {
            conn.write(JSON.stringify({ ok: false, error: "Invalid JSON" }) + "\n");
          }
        }
      });

      conn.on("error", () => { /* ignore connection errors */ });
    });

    server.on("error", (err) => {
      console.error(`[bryti-bridge] Socket error: ${err.message}`);
    });

    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch { /* ignore */ }
    });
  });

  pi.on("session_shutdown", async () => {
    if (server) {
      server.close();
      server = null;
    }
    if (currentSocketPath) {
      try { fs.unlinkSync(currentSocketPath); } catch { /* ignore */ }
      currentSocketPath = null;
    }
    sendUserMessage = null;
  });
}
