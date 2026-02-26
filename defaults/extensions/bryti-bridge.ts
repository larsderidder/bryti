/**
 * Bryti Bridge - Allows bryti to inject messages into running pi sessions.
 *
 * Creates a Unix socket at /tmp/bryti-pi-<session-id>.sock that accepts
 * JSON messages. Bryti's pi_session_inject tool connects to this socket
 * to send messages into the running session.
 *
 * Protocol: one JSON object per line (newline-delimited JSON)
 *   Request:  { "type": "user_message", "text": "..." }
 *   Response: { "ok": true } or { "ok": false, "error": "..." }
 */

import * as net from "node:net";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SOCKET_DIR = "/tmp";

function socketPath(sessionId: string): string {
  return `${SOCKET_DIR}/bryti-pi-${sessionId}.sock`;
}

export default function (pi: ExtensionAPI) {
  let server: net.Server | null = null;
  let currentSocketPath: string | null = null;
  let sendUserMessage: ((text: string) => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return;

    // Capture sendUserMessage from the API
    sendUserMessage = (text: string) => pi.sendUserMessage(text);

    const sockPath = socketPath(sessionId);
    currentSocketPath = sockPath;

    // Clean up stale socket from a previous crash
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }

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
      // Make socket owner-accessible only
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
