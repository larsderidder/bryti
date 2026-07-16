import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower.includes("authorization") || lower.includes("api-key") || lower.includes("token")) {
      out[key] = "[redacted]";
    } else {
      out[key] = value;
    }
  }
  return out;
}

function appendJsonl(filePath: string, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // Observability must never affect the agent loop.
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("after_provider_response", (event, ctx) => {
    const logPath = path.join(ctx.cwd, "logs", "provider-responses.jsonl");
    const headers = redactHeaders(event.headers as Record<string, string> | undefined);
    appendJsonl(logPath, {
      timestamp: new Date().toISOString(),
      status: event.status,
      mode: ctx.mode,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      request_id: headers?.["x-request-id"] ?? headers?.["request-id"] ?? headers?.["cf-ray"] ?? null,
      rate_limit: Object.fromEntries(
        Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase().includes("rate")),
      ),
    });
  });

  pi.on("session_compact", (event, ctx) => {
    const logPath = path.join(ctx.cwd, "logs", "extension-compactions.jsonl");
    appendJsonl(logPath, {
      timestamp: new Date().toISOString(),
      mode: ctx.mode,
      reason: event.reason,
      will_retry: event.willRetry,
      from_extension: event.fromExtension,
      compaction_entry_id: event.compactionEntry.id,
      context_usage: ctx.getContextUsage(),
    });
  });
}
