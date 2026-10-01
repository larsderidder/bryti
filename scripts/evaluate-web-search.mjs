#!/usr/bin/env node
/**
 * Compare actual local search tools with anonymous Parallel MCP, without model calls or configuration changes.
 * Run with: node --import tsx scripts/evaluate-web-search.mjs --output /tmp/web-search-evaluation.json
 * Counts and literal term matches are diagnostic proxies, not answer-quality scores.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    limit: { type: "string", default: "5" },
    "skip-extract": { type: "boolean", default: false },
    "bryti-parallel": { type: "boolean", default: false },
    "pi-extension": { type: "string", default: "/home/lars/.pi/agent/extensions/search.ts" },
    "searxng-url": { type: "string", default: "https://search.xithing.eu" },
  },
});
const cases = JSON.parse(await readFile(new URL("./web-search-cases.json", import.meta.url), "utf8"));
const searchLimit = Number(values.limit);
if (!Number.isInteger(searchLimit) || searchLimit < 0 || searchLimit > cases.searches.length) {
  throw new Error("limit must select an existing number of search cases");
}

const sourcePaths = [
  values["pi-extension"],
  path.resolve(path.dirname(values["pi-extension"]), "../lib/search-utils.ts"),
  new URL("../src/tools/web-search.ts", import.meta.url),
  new URL("../src/tools/fetch-url.ts", import.meta.url),
  new URL("../src/tools/searxng.ts", import.meta.url),
  new URL("../src/tools/parallel-search.ts", import.meta.url),
  new URL("../src/util/ssrf.ts", import.meta.url),
  new URL("../src/util/response-body.ts", import.meta.url),
];

/** Detect working-tree changes while measuring instead of silently mixing baselines. */
async function fingerprintSources() {
  const fingerprints = {};
  for (const source of sourcePaths) {
    if (existsSync(source)) {
      fingerprints[String(source)] = createHash("sha256").update(await readFile(source)).digest("hex");
    }
  }
  return fingerprints;
}

const sourceHashesBefore = await fingerprintSources();
const { createWebSearchTool } = await import("../src/tools/web-search.ts");
const { createFetchUrlTool } = await import("../src/tools/fetch-url.ts");
const { createParallelTools } = await import("../src/tools/parallel-search.ts");
const [brytiParallelSearch, brytiParallelFetch] = createParallelTools();

const { McpClient, StreamableHttpTransport } = await import("@earendil-works/pi-mcp");
const { default: searchExtension } = await import(pathToFileURL(values["pi-extension"]));
const piTools = new Map();
searchExtension({ registerTool(tool) { piTools.set(tool.name, tool); } });
const brytiSearch = createWebSearchTool(values["searxng-url"]);
const brytiExtract = createFetchUrlTool(10_000, { backend: "readability" });
const parallel = new McpClient({ name: "bryti-search-evaluation", version: "1.0.0", requestTimeoutMs: 40_000 });
const sessionId = randomUUID();
const transportErrors = [];
parallel.onError((error) => transportErrors.push(error.message));
const records = [];
let parallelError;
let parallelTools = [];
let connectMs;

/** Turn a native tool result into the text the model would normally consume. */
function textContent(result) {
  return (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

/** Recover the provider payload while retaining raw model-visible text separately. */
function parallelPayload(result) {
  if (result.isError) {
    throw new Error(textContent(result));
  }
  if (result.structuredContent) {
    return result.structuredContent;
  }
  for (const block of result.content ?? []) {
    if (block.type === "text") {
      try {
        return JSON.parse(block.text);
      } catch {
        continue;
      }
    }
  }
  throw new Error("Parallel returned no structured or JSON payload");
}

/** Match host and optional path prefixes, without treating lookalike domains as official. */
function matchesOfficial(url, prefixes) {
  try {
    const candidate = new URL(url);
    return prefixes.some((prefix) => {
      const expected = new URL(`https://${prefix}`);
      const hostMatches = candidate.hostname === expected.hostname || candidate.hostname.endsWith(`.${expected.hostname}`);
      return hostMatches && candidate.pathname.toLowerCase().startsWith(expected.pathname.toLowerCase());
    });
  } catch {
    return false;
  }
}

/** Measure real tool calls and capture failures as failures, including non-throwing tools. */
async function measure(kind, provider, item, action) {
  const start = performance.now();
  let record;
  try {
    const result = await action();
    const details = result.details ?? {};
    if (result.isError || details.error) {
      throw new Error(details.error ?? textContent(result));
    }
    const text = textContent(result);
    const results = details.results ?? [];
    const failedRuns = (details.runs ?? []).filter((run) => run.error || run.results.length === 0);
    const recordData = {
      kind, provider, caseId: item.id, elapsedMs: Math.round(performance.now() - start),
      outputChars: text.length, resultCount: results.length,
      officialTopFive: results.slice(0, 5).filter((result) => matchesOfficial(result.url, item.officialDomains ?? [])).length,
      termMatches: item.evidenceTerms.filter((term) => text.toLowerCase().includes(term.toLowerCase())),
      searchedQueries: details.searchedQueries,
      degradedEngines: details.degradedEngines,
      runs: details.runs,
      providerTraces: details.providerTraces,
      citations: details.citations,
      sourceCount: details.sourceCount,
      failureCount: details.failureCount,
      extractor: details.extractor,
      transport: details.transport,
      results, text,
    };
    record = { ...recordData, ok: text.length > 0 && (kind !== "search" || results.length > 0), emptyOrFailedRuns: failedRuns.length };
    if (kind === "extract" && Array.isArray(details.results) && results.length === 0) {
      record.ok = false;
      record.errors = details.errors;
    }
    if (kind === "extract" && details.sourceCount === 0) {
      record.ok = false;
    }
  } catch (error) {
    record = { kind, provider, caseId: item.id, ok: false, elapsedMs: Math.round(performance.now() - start), error: error.message };
  }
  records.push(record);
  console.error(`${kind} ${provider} ${item.id}: ok=${record.ok} ${record.elapsedMs}ms chars=${record.outputChars ?? 0}`);
}

/** Emit medians from successful samples; keep unsuccessful samples in explicit counts. */
function summarize() {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.kind}:${record.provider}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(record);
  }
  return [...groups].map(([group, samples]) => {
    const successful = samples.filter((sample) => sample.ok);
    const latency = successful.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
    const chars = successful.map((sample) => sample.outputChars).sort((a, b) => a - b);
    const index = Math.floor(successful.length / 2);
    let medianMs = null;
    let medianChars = null;
    if (successful.length > 0) {
      medianMs = latency[index];
      medianChars = chars[index];
      if (successful.length % 2 === 0) {
        medianMs = (latency[index - 1] + latency[index]) / 2;
        medianChars = (chars[index - 1] + chars[index]) / 2;
      }
    }
    return {
      group, successful: successful.length, attempted: samples.length, medianMs, medianChars,
      officialTopFiveTotal: successful.reduce((sum, sample) => sum + sample.officialTopFive, 0),
      emptyOrFailedRuns: successful.reduce((sum, sample) => sum + sample.emptyOrFailedRuns, 0),
    };
  });
}

try {
  const started = performance.now();
  try {
    await parallel.connect(new StreamableHttpTransport({
      url: "https://search.parallel.ai/mcp", openGetStream: false, maxMessageBytes: 2 * 1024 * 1024,
    }));
    parallelTools = await parallel.listTools();
    connectMs = Math.round(performance.now() - started);
  } catch (error) {
    parallelError = error.message;
  }

  for (const item of cases.searches.slice(0, searchLimit)) {
    const jobs = [
      measure("search", "pi-balanced", item, () => piTools.get("web_search").execute(randomUUID(), {
        queries: item.queries, count: 10, language: item.language, search_depth: "balanced",
      })),
      measure("search", "pi-fast", item, () => piTools.get("web_search").execute(randomUUID(), {
        queries: item.queries, count: 10, language: item.language, search_depth: "fast",
      })),
      measure("search", "bryti-searxng", item, () => brytiSearch.execute(randomUUID(), {
        query: item.queries[0], count: 10, language: item.language,
      })),
      measure("search", "parallel-free", item, async () => {
        if (parallelError) {
          throw new Error(parallelError);
        }
        const result = await parallel.callTool("web_search", {
          objective: item.objective, search_queries: item.queries, session_id: sessionId,
        });
        return { ...result, details: parallelPayload(result) };
      }),
    ];
    if (values["bryti-parallel"]) {
      jobs.push(measure("search", "bryti-parallel", item, () => brytiParallelSearch.execute(randomUUID(), {
        objective: item.objective, search_queries: item.queries,
      })));
    }
    await Promise.all(jobs);
  }

  if (!values["skip-extract"]) {
    for (const item of cases.extractions) {
      const jobs = [
        measure("extract", "pi-web-extract", item, () => piTools.get("web_extract").execute(randomUUID(), {
          urls: [item.url], query: item.objective, max_chars_per_url: 6000, max_total_chars: 6000,
        })),
        measure("extract", "bryti-readability", item, () => brytiExtract.execute(randomUUID(), {
          url: item.url, max_chars: 6000,
        })),
        measure("extract", "parallel-free", item, async () => {
          if (parallelError) {
            throw new Error(parallelError);
          }
          const result = await parallel.callTool("web_fetch", {
            urls: [item.url], objective: item.objective, search_queries: item.queries, session_id: sessionId,
          });
          return { ...result, details: parallelPayload(result) };
        }),
      ];
      if (values["bryti-parallel"]) {
        jobs.push(measure("extract", "bryti-parallel", item, () => brytiParallelFetch.execute(randomUUID(), {
          urls: [item.url], objective: item.objective, search_queries: item.queries,
        })));
      }
      await Promise.all(jobs);
    }
  }
} finally {
  await parallel.close();
}

const report = {
  generatedAt: new Date().toISOString(),
  methodology: {
    note: "Small live smoke comparison, not an answer benchmark. No model calls. Output length measures characters, not tokens. Official-domain counts and term matches do not measure relevance or correctness. Provider requests overlap; first-call MCP setup is recorded separately. Caches and backend engine health affect timings.",
    brytiQueries: "First query only, matching one call of its current tool; pi and Parallel receive both query variants.",
    piExtension: values["pi-extension"], searxngUrl: values["searxng-url"], sessionId,
  },
  parallel: { connectMs, error: parallelError, serverInfo: parallel.serverInfo, tools: parallelTools, transportErrors },
  inputs: cases, summary: summarize(), records,
  sourceHashesBefore, sourceHashesAfter: await fingerprintSources(),
};
if (values.output) {
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
console.log(JSON.stringify({
  parallel: { connectMs, error: parallelError, toolNames: parallelTools.map((tool) => tool.name), transportErrors },
  sourcesChanged: JSON.stringify(report.sourceHashesBefore) !== JSON.stringify(report.sourceHashesAfter),
  summary: report.summary, output: values.output,
}, null, 2));
