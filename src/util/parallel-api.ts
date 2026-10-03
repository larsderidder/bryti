import axios from "axios";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { callAnonymousParallel } from "./parallel-anonymous.js";

export interface ParallelApiOptions {
  access?: "anonymous" | "authenticated";
  apiKey?: string;
  apiKeyFile?: string;
  timeoutMs?: number;
  maxRequestsPerHour?: number;
  signal?: AbortSignal;
}

export interface ParallelPage {
  url: string;
  title: string;
  excerpts: string[];
  fullContent?: string;
  publishDate?: string;
}

export interface ParallelResponse {
  results: ParallelPage[];
  warnings: string[];
  latencyMs: number;
  requestId?: string;
}

const requests = new Map<string, { startedAt: number; count: number; blockedUntil: number }>();
const MAX_BYTES = 2 * 1024 * 1024;

/** Read operator credentials without forwarding them to tool output or provider diagnostics. */
export function parallelApiKey(options: ParallelApiOptions): string {
  let key = options.apiKey ?? process.env.PARALLEL_API_KEY;
  if (!key) {
    const path = options.apiKeyFile ?? process.env.PARALLEL_API_KEY_FILE ?? join(homedir(), ".config/parallel/api-key");
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error("Parallel credential file must be a private, operator-owned regular file");
      }
      key = readFileSync(path, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Cannot read a private Parallel credential file");
      }
    }
  }
  if (!key || key.length > 4096 || /[\r\n]/.test(key)) {
    throw new Error("Parallel credential unavailable; configure PARALLEL_API_KEY or a private PARALLEL_API_KEY_FILE");
  }
  return key;
}

/** Validate result fields without forwarding remote instructions or arbitrary objects. */
function pageFromJson(value: unknown): ParallelPage {
  if (!value || typeof value !== "object") {
    throw new Error("Parallel returned an invalid result");
  }
  const page = value as Record<string, unknown>;
  if (typeof page.url !== "string" || page.url.length > 2048 || !Array.isArray(page.excerpts)
    || page.excerpts.some((excerpt) => typeof excerpt !== "string")) {
    throw new Error("Parallel returned invalid result fields");
  }
  const url = new URL(page.url);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Parallel returned an unsafe result URL");
  }
  const result: ParallelPage = {
    url: url.href, title: url.hostname, excerpts: (page.excerpts as string[]).map((text) => text.slice(0, 20_000)),
  };
  if (typeof page.title === "string") {
    result.title = page.title.slice(0, 1000);
  }
  if (typeof page.full_content === "string") {
    result.fullContent = page.full_content;
  }
  if (typeof page.publish_date === "string") {
    result.publishDate = page.publish_date;
  }
  return result;
}

/** Make one bounded call; authentication requires explicit opt-in, never merely an available key. */
async function callParallel(endpoint: "search" | "extract", body: object, options: ParallelApiOptions): Promise<ParallelResponse> {
  options.signal?.throwIfAborted();
  let key: string | undefined;
  if (options.access === "authenticated") {
    key = parallelApiKey(options);
  }
  const limit = options.maxRequestsPerHour ?? Number(process.env.PARALLEL_MAX_REQUESTS_PER_HOUR ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("Parallel request ceiling must be an integer between 1 and 10000");
  }
  const now = Date.now();
  let identity = "anonymous";
  if (key) {
    identity = createHash("sha256").update(key).digest("hex");
  }
  let budget = requests.get(identity);
  if (!budget || now - budget.startedAt >= 3_600_000) {
    budget = { startedAt: now, count: 0, blockedUntil: 0 };
    requests.set(identity, budget);
  }
  if (budget.count >= limit || budget.blockedUntil > now) {
    throw new Error("Parallel request ceiling or provider cooldown reached");
  }
  budget.count += 1;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  let signal = deadline;
  if (options.signal) {
    signal = AbortSignal.any([deadline, options.signal]);
  }
  if (options.access !== "authenticated") {
    try {
      const data = await callAnonymousParallel(endpoint, body as Record<string, unknown>, signal);
      const response = normalizeResponse(data, endpoint, now);
      if (endpoint === "search") {
        response.warnings.push("Anonymous Parallel uses provider-managed fast mode; domain and date constraints are query hints, not guaranteed filters.");
      }
      return response;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof Error && /HTTP 429/.test(error.message)) {
        budget.blockedUntil = Date.now() + 60_000;
      }
      throw error;
    }
  }
  let response;
  try {
    response = await axios.post(`https://api.parallel.ai/v1/${endpoint}`, body, {
      adapter: "http", httpVersion: 1, proxy: false, maxRedirects: 0,
      signal, timeout: options.timeoutMs ?? 15_000, validateStatus: () => true,
      maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES,
      headers: { "x-api-key": key, "Content-Type": "application/json" },
    });
  } catch {
    options.signal?.throwIfAborted();
    // Axios errors can contain request headers. Never return the error object or message.
    throw new Error("Parallel request failed or timed out");
  }
  signal.throwIfAborted();
  if (response.status === 429) {
    let delay = Number(response.headers["retry-after"]);
    if (!Number.isFinite(delay) || delay <= 0) {
      delay = 60;
    }
    budget.blockedUntil = Date.now() + Math.min(delay, 3600) * 1000;
  }
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw new Error(`Parallel returned HTTP ${response.status}`);
  }
  return normalizeResponse(response.data, endpoint, now);
}

/** Accept only bounded structured results, not MCP prose or server instructions. */
function normalizeResponse(data: unknown, endpoint: "search" | "extract", startedAt: number): ParallelResponse {
  if (!data || typeof data !== "object" || !Array.isArray((data as Record<string, unknown>).results)) {
    throw new Error("Parallel returned an invalid response");
  }
  const payload = data as Record<string, unknown>;
  if (endpoint === "extract" && (!Array.isArray(payload.errors) || payload.errors.length > 0)) {
    throw new Error("Parallel extraction failed or omitted extraction diagnostics");
  }
  const warnings: string[] = [];
  if (Array.isArray(payload.warnings) && payload.warnings.length > 0) {
    warnings.push("Parallel reported input adjustments or provider warnings");
  }
  let requestId: string | undefined;
  const id = payload.search_id ?? payload.extract_id;
  if (typeof id === "string") {
    requestId = id.slice(0, 200);
  }
  return { results: (payload.results as unknown[]).slice(0, 20).map(pageFromJson), warnings, latencyMs: Date.now() - startedAt, requestId };
}

/** Search related variants in one call. Anonymous MCP always uses provider-managed fast mode. */
export function parallelSearch(input: {
  queries: string[]; objective?: string; count?: number; mode?: "fast" | "advanced";
  includeDomains?: string[]; excludeDomains?: string[]; afterDate?: string;
}, options: ParallelApiOptions = {}): Promise<ParallelResponse> {
  if (!input.queries.length || input.queries.length > 4 || input.queries.some((query) => !query.trim() || query.length > 1000)) {
    throw new Error("Parallel requires one to four bounded search queries");
  }
  const sourcePolicy: Record<string, unknown> = {};
  if (input.includeDomains?.length) {
    sourcePolicy.include_domains = input.includeDomains;
  }
  if (input.excludeDomains?.length) {
    sourcePolicy.exclude_domains = input.excludeDomains;
  }
  if (input.afterDate) {
    sourcePolicy.after_date = input.afterDate;
  }
  return callParallel("search", {
    objective: (input.objective ?? input.queries.join("; ")).slice(0, 1000), search_queries: input.queries,
    mode: input.mode ?? "fast",
    advanced_settings: { max_results: Math.min(Math.max(input.count ?? 10, 1), 20), source_policy: sourcePolicy },
  }, options).then((response) => ({ ...response, results: response.results.slice(0, Math.min(Math.max(input.count ?? 10, 1), 20)) }));
}

/** Request live full content for a URL already checked by the caller's public-URL guard. */
export async function parallelExtract(url: string, options: ParallelApiOptions = {}): Promise<ParallelPage> {
  const response = await callParallel("extract", {
    urls: [url], full_content: true, fetch_policy: { max_age_seconds: 0 },
  }, options);
  const page = response.results.find((result) => result.url === new URL(url).href);
  if (!page?.fullContent?.trim()) {
    throw new Error("Parallel returned no full content for the requested URL");
  }
  const heading = /^#\s+([^\n]+)/m.exec(page.fullContent.slice(0, 1000))?.[1]?.trim() ?? "";
  if (/^(?:404|page not found|not found|access denied)$/i.test(page.title.trim())
    || /^(?:404|page not found|not found|access denied)$/i.test(heading)
    || /^Warning: Target URL returned error [45]\d\d\b/m.test(page.fullContent.slice(0, 1000))) {
    throw new Error("Parallel returned a target error page");
  }
  return page;
}
