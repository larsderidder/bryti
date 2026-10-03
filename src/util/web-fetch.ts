import dns from "node:dns";
import net from "node:net";
import axios, { type AddressFamily, type LookupAddress } from "axios";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { isPrivateIp, lookupWithSignal } from "./ssrf.js";
import { parallelExtract, type ParallelApiOptions } from "./parallel-api.js";

export interface FirecrawlOptions {
  enabled: boolean;
  apiKey?: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  requireHttps?: boolean;
  firecrawl?: FirecrawlOptions;
  parallel?: ParallelApiOptions & { enabled: boolean };
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status?: number;
  contentType: string;
  title: string;
  text: string;
  extractor: string;
  source_type: "live" | "paid_api" | "hosted_api";
  warning?: string;
}

const MAX_BYTES = 2 * 1024 * 1024;
const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

class FetchError extends Error {
  fallbackAllowed: boolean;

  constructor(message: string, fallbackAllowed = false) {
    super(message);
    this.fallbackAllowed = fallbackAllowed;
  }
}

/** Check URL syntax independently of DNS, including every redirect. */
function checkUrl(raw: string, requireHttps: boolean): URL {
  if (raw.length > 2048) {
    throw new FetchError("URL is too long");
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && (requireHttps || url.protocol !== "http:")) {
    throw new FetchError("Use HTTPS URLs only");
  }
  if (url.username || url.password) {
    throw new FetchError("URLs with embedded credentials are blocked");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host === "metadata" || /\.(localhost|local|internal|corp|lan)$/.test(host)
    || (net.isIP(host) && isPrivateIp(host))) {
    throw new FetchError("Blocked private or internal URL");
  }
  return url;
}

/** Revalidate the address used by the HTTP connection, preventing DNS rebinding. */
function safeLookup(hostname: string, options: object, callback: (error: Error | null, address: LookupAddress | LookupAddress[], family?: AddressFamily) => void): void {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "");
      return;
    }
    if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
      callback(Object.assign(new FetchError("Blocked private DNS result"), { code: "ERR_UNSAFE_URL" }), "");
      return;
    }
    const resolved = addresses.map(({ address }) => {
      let family: 4 | 6 = 4;
      if (net.isIPv6(address)) {
        family = 6;
      }
      return { address, family };
    });
    if ((options as { all?: boolean }).all) {
      callback(null, resolved);
    } else {
      callback(null, resolved[0].address, resolved[0].family);
    }
  });
}

/** Strip boilerplate without executing scripts, then preserve readable content as Markdown. */
export function extractHtml(html: string): { title: string; text: string; extractor: string; warning?: string } {
  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent?.trim().slice(0, 256) ?? "";
  const heading = document.querySelector("h1")?.textContent?.trim() ?? "";
  if (/^(?:page not found|not found)(?:\s*[|:\-].*)?$|^404(?:\s*[|:\-].*)?$/i.test(title)
    || /^(?:page not found|not found|404)$/i.test(heading)) {
    throw new FetchError("Target page not found");
  }
  if (/^(?:access denied|just a moment|403 forbidden|verify you are human)\b/i.test(title)) {
    throw new FetchError("Target returned a challenge or access-denied page", true);
  }
  for (const node of Array.from(document.querySelectorAll("script,style,noscript,iframe,nav,footer,[hidden],[aria-hidden='true']"))) {
    node.remove();
  }
  for (const node of Array.from(document.querySelectorAll("[style]"))) {
    const style = (node.getAttribute("style") ?? "").replace(/\s/g, "").toLowerCase();
    if (style.includes("display:none") || style.includes("visibility:hidden")) {
      node.remove();
    }
  }
  const article = new Readability(document.cloneNode(true) as unknown as Document, { maxElemsToParse: 20_000 }).parse();
  if (article?.content && article.textContent?.trim()) {
    return { title: (article.title || title).slice(0, 256), text: markdown.turndown(article.content), extractor: "readability" };
  }
  const body = document.querySelector("main,article") ?? document.body;
  const text = markdown.turndown(body?.innerHTML ?? "").trim();
  if (!text) {
    throw new FetchError("No readable content was extracted", true);
  }
  return { title, text, extractor: "raw-html", warning: "Readability failed; this is basic HTML cleanup, not validated main content." };
}

/** Fetch verified live content; paid fallback requires explicit configuration and never handles 404s or unsafe URLs. */
export async function fetchPage(rawUrl: string, options: FetchOptions = {}): Promise<FetchedPage> {
  options.signal?.throwIfAborted();
  const requireHttps = options.requireHttps !== false;
  const url = checkUrl(rawUrl, requireHttps);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  let combined = signal;
  if (options.signal) {
    combined = AbortSignal.any([options.signal, signal]);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!net.isIP(host)) {
    const addresses = await lookupWithSignal(host, combined);
    if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
      throw new FetchError("Blocked private DNS result");
    }
  }
  let failure: unknown;
  try {
    const response = await axios.get<string>(url.href, {
      adapter: "http", httpVersion: 1,
      responseType: "text", timeout: options.timeoutMs ?? 30_000, signal: combined,
      maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES, maxRedirects: 3, proxy: false,
      lookup: safeLookup,
      validateStatus: () => true,
      headers: { Accept: "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1", "User-Agent": "Mozilla/5.0 (compatible; web-fetch/1.0)" },
      beforeRedirect: (redirect) => {
        if (redirect.auth) {
          throw new FetchError("Redirects with embedded credentials are blocked");
        }
        checkUrl(`${redirect.protocol}//${redirect.hostname}${redirect.path ?? "/"}`, requireHttps);
      },
    });
    combined.throwIfAborted();
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw new FetchError(`Target returned HTTP ${response.status}`, response.status === 403 || response.status === 429 || response.status >= 500);
    }
    const contentType = String(response.headers["content-type"] ?? "text/plain").split(";")[0].trim().toLowerCase();
    const finalUrl = response.request?.res?.responseUrl || url.href;
    checkUrl(finalUrl, requireHttps);
    let extracted = { title: "", text: String(response.data).trim(), extractor: "text", warning: undefined as string | undefined };
    if (["text/html", "application/xhtml+xml"].includes(contentType)) {
      extracted = { warning: undefined, ...extractHtml(response.data) };
      if (extracted.extractor === "raw-html" && (options.parallel?.enabled || options.firecrawl?.enabled)) {
        throw new FetchError("Readability could not isolate main content", true);
      }
    } else if (contentType === "text/markdown" || (contentType === "text/plain" && url.pathname.endsWith(".md"))) {
      extracted.extractor = "native-markdown";
      extracted.title = /^#\s+([^\n]+)/m.exec(extracted.text)?.[1]?.trim().slice(0, 256) ?? "";
    } else if (contentType === "application/json" || contentType.endsWith("+json")) {
      extracted.text = JSON.stringify(JSON.parse(response.data), null, 2);
      extracted.extractor = "json";
    } else if (contentType !== "text/plain") {
      throw new FetchError(`Unsupported content type: ${contentType}`, true);
    }
    if (!extracted.text) {
      throw new FetchError("Target returned no readable content", true);
    }
    return { url: url.href, finalUrl, status: response.status, contentType, ...extracted, source_type: "live" };
  } catch (error) {
    combined.throwIfAborted();
    failure = error;
    const retryableNetwork = axios.isAxiosError(error) && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNABORTED"].includes(error.code ?? "");
    if (!(error instanceof FetchError && error.fallbackAllowed) && !retryableNetwork) {
      throw error;
    }
    if (!options.parallel?.enabled && !options.firecrawl?.enabled) {
      throw error;
    }
  }
  if (options.parallel?.enabled) {
    const page = await parallelExtract(url.href, { ...options.parallel, signal: combined });
    let sourceType: "hosted_api" | "paid_api" = "hosted_api";
    if (options.parallel.access === "authenticated") {
      sourceType = "paid_api";
    }
    return {
      url: url.href, finalUrl: url.href, contentType: "text/markdown", title: page.title,
      text: page.fullContent!.trim(), extractor: "parallel", source_type: sourceType,
      warning: "Direct extraction was unusable; used hosted Parallel. Target HTTP status, final redirect URL and freshness are unverified.",
    };
  }
  const key = options.firecrawl?.apiKey;
  if (!key) {
    throw new FetchError("Firecrawl is enabled but no API key is configured");
  }
  const result = await axios.post("https://api.firecrawl.dev/v2/scrape", {
    url: url.href, formats: ["markdown"], onlyMainContent: true, maxAge: 0,
  }, {
    adapter: "http", httpVersion: 1,
    signal: combined, timeout: options.timeoutMs ?? 30_000, maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES,
    maxRedirects: 0, proxy: false, lookup: safeLookup,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  combined.throwIfAborted();
  const data = result.data?.data;
  const status = data?.metadata?.statusCode;
  if (result.data?.success !== true || !Number.isInteger(status) || status < 200 || status >= 300) {
    throw new FetchError(`Firecrawl target status is unsuccessful or unverified: ${String(status ?? "missing")}`);
  }
  if (typeof data.markdown !== "string" || !data.markdown.trim()) {
    throw new FetchError("Firecrawl returned no readable content");
  }
  let reason = "fetch error";
  if (failure instanceof Error) {
    reason = failure.message;
  }
  return {
    url: url.href, finalUrl: url.href, status, contentType: "text/markdown", title: String(data.metadata?.title ?? "").slice(0, 256),
    text: data.markdown.trim(), extractor: "firecrawl", source_type: "paid_api",
    warning: `Direct extraction failed (${reason}); used explicitly enabled Firecrawl. Final redirect URL is unverified.`,
  };
}
