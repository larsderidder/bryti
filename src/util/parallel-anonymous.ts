import { randomUUID } from "node:crypto";
import { McpClient, McpHttpError, StreamableHttpTransport } from "@earendil-works/pi-mcp";

const SESSION_ID = randomUUID();
const ENDPOINT = "https://search.parallel.ai/mcp";
const MAX_BYTES = 2 * 1024 * 1024;

/** Bound error responses too; the native transport already bounds successful MCP messages. */
async function boundedErrorResponse(response: Response): Promise<Response> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Response(null, { status: response.status, headers: response.headers });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > 8192) {
        chunks.length = 0;
        break;
      }
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new Response(new Uint8Array(Buffer.concat(chunks)), { status: response.status, headers: response.headers });
}

/** Call only the fixed anonymous tools, without credentials, configurable servers, or remote instructions. */
export async function callAnonymousParallel(endpoint: "search" | "extract", body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const client = new McpClient({ name: "parallel-web", version: "1.0.0", requestTimeoutMs: 30_000 });
  const transport = new StreamableHttpTransport({
    url: ENDPOINT, openGetStream: false, maxMessageBytes: MAX_BYTES, reconnect: { maxRetries: 0 },
    async fetch(input, init) {
      let requestSignal = signal;
      if (init?.signal) {
        requestSignal = AbortSignal.any([signal, init.signal]);
      }
      requestSignal.throwIfAborted();
      if (String(input) !== ENDPOINT) {
        throw new Error("Parallel can only call its fixed anonymous endpoint");
      }
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      headers.delete("x-api-key");
      const response = await fetch(input, { ...init, headers, signal: requestSignal, redirect: "error", credentials: "omit" });
      if (!response.ok) {
        return boundedErrorResponse(response);
      }
      return response;
    },
  });
  let name = "web_search";
  let args: Record<string, unknown> = {
    objective: body.objective, search_queries: body.search_queries, session_id: SESSION_ID,
  };
  if (endpoint === "extract") {
    name = "web_fetch";
    args = { urls: body.urls, full_content: true, session_id: SESSION_ID };
  }
  const onAbort = () => { void client.close().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await client.connect(transport);
    signal.throwIfAborted();
    const result = await client.callTool(name, args, { signal });
    if (result.isError) {
      throw new Error("Parallel anonymous tool reported an error");
    }
    if (result.structuredContent !== undefined) {
      return result.structuredContent;
    }
    for (const block of result.content) {
      if (block.type === "text") {
        try {
          return JSON.parse(block.text) as unknown;
        } catch {
          // Ignore prose and remote instructions, accepting only structured data.
        }
      }
    }
    throw new Error("Parallel anonymous tool returned no structured data");
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof McpHttpError) {
      throw new Error(`Parallel anonymous endpoint returned HTTP ${error.status}`);
    }
    throw new Error("Parallel anonymous request failed or returned invalid data");
  } finally {
    signal.removeEventListener("abort", onAbort);
    await client.close();
  }
}
