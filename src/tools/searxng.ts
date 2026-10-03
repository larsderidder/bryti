import http from "node:http";
import https from "node:https";

export interface SearxngOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}

/** Validate the operator-selected endpoint without excluding private self-hosted instances. */
export function searxngEndpoint(base: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("SearXNG endpoint must be an HTTP or HTTPS URL");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("SearXNG endpoint must use HTTP(S) without credentials, query parameters, or fragments");
  }
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}/search`;
  return url;
}

/** Read a bounded JSON response without following redirects or outliving the caller. */
export async function fetchSearxngJson(url: URL, options: SearxngOptions, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let response: http.IncomingMessage | undefined;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        response?.destroy();
        request.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const abort = () => finish(new DOMException("Search cancelled", "AbortError"));
    let transport: typeof http | typeof https = http;
    if (url.protocol === "https:") {
      transport = https;
    }
    const request = transport.get(url, { headers: { Accept: "application/json" } }, (incoming) => {
      response = incoming;
      const status = incoming.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        finish(new Error(`SearXNG returned HTTP ${status}`));
        return;
      }
      const maxBytes = options.maxResponseBytes ?? 1_000_000;
      let size = 0;
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          finish(new Error("SearXNG response exceeds the byte limit"));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("error", (error: Error) => finish(error));
      incoming.on("aborted", () => finish(new Error("SearXNG response was interrupted")));
      incoming.on("end", () => {
        if (settled) {
          return;
        }
        try {
          finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          finish(new Error("Invalid SearXNG response JSON"));
        }
      });
    });
    const timer = setTimeout(() => finish(new Error("SearXNG request timed out")), options.timeoutMs ?? 10_000);
    request.on("error", (error: Error) => finish(error));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
  });
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

/** Drop malformed entries and reject an invalid catalog instead of trusting the response shape. */
export function parseSearxngResults(value: unknown, limit: number): { results: SearchResult[]; total: number; unresponsiveEngines: string[][] } {
  if (!value || typeof value !== "object" || !Array.isArray((value as { results?: unknown }).results)) {
    throw new Error("Invalid SearXNG response: results must be an array");
  }
  const response = value as { results: unknown[]; number_of_results?: unknown; unresponsive_engines?: unknown };
  if (!Number.isFinite(limit)) {
    throw new Error("Invalid SearXNG result limit");
  }
  const maxResults = Math.max(0, Math.min(20, Math.floor(limit)));
  const results: SearchResult[] = [];
  for (const entry of response.results) {
    if (results.length >= maxResults) {
      break;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.title !== "string" || typeof candidate.url !== "string" || candidate.url.length > 4096) {
      continue;
    }
    try {
      const url = new URL(candidate.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        continue;
      }
    } catch {
      continue;
    }
    let snippet = "";
    let engine = "unknown";
    if (typeof candidate.content === "string") {
      snippet = candidate.content.slice(0, 300);
    }
    if (typeof candidate.engine === "string") {
      engine = candidate.engine.slice(0, 100);
    }
    results.push({ title: candidate.title.slice(0, 1000), url: candidate.url, snippet, engine });
  }
  let total = 0;
  if (typeof response.number_of_results === "number" && Number.isFinite(response.number_of_results)) {
    total = Math.max(0, response.number_of_results);
  }
  const unresponsiveEngines: string[][] = [];
  if (Array.isArray(response.unresponsive_engines)) {
    for (const entry of response.unresponsive_engines.slice(0, 50)) {
      if (Array.isArray(entry) && entry.every((field) => typeof field === "string")) {
        unresponsiveEngines.push(entry.slice(0, 2).map((field: string) => field.slice(0, 200)));
      }
    }
  }
  return { results, total, unresponsiveEngines };
}
