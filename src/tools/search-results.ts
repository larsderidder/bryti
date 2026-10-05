export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  providers?: string[];
}

/** Fuse bounded provider rankings without treating duplicate URLs as extra votes. */
export function mergeSearchResults(lists: Array<{ provider: string; results: SearchResult[] }>, query: string, count: number): SearchResult[] {
  if (!Number.isFinite(count) || count < 1) {
    return [];
  }
  const limit = Math.min(Math.floor(count), 20);
  const entries = new Map<string, { result: SearchResult; providers: Set<string>; score: number; domain: string }>();
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((term) => term.length >= 3);
  for (const list of lists) {
    const seen = new Set<string>();
    for (const [index, result] of list.results.slice(0, 20).entries()) {
      let url: URL;
      try {
        url = new URL(result.url);
      } catch {
        continue;
      }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        continue;
      }
      url.hash = "";
      for (const name of [...url.searchParams.keys()]) {
        if (/^utm_/i.test(name) || name === "gclid" || name === "fbclid") {
          url.searchParams.delete(name);
        }
      }
      url.searchParams.sort();
      const domain = url.hostname.replace(/^www\./, "");
      const key = `${domain}:${url.port}${url.pathname.replace(/\/$/, "")}${url.search}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      let entry = entries.get(key);
      if (!entry) {
        entry = { result: { ...result }, providers: new Set(), score: 0, domain };
        entries.set(key, entry);
      }
      entry.score += 1 / (60 + index + 1);
      entry.providers.add(list.provider);
      if (result.snippet.length > entry.result.snippet.length) {
        entry.result.title = result.title;
        entry.result.snippet = result.snippet;
        entry.result.engine = result.engine;
      }
      if (url.protocol === "https:") {
        entry.result.url = result.url;
      }
    }
  }
  for (const entry of entries.values()) {
    const text = `${entry.result.title} ${entry.result.snippet}`.toLowerCase();
    const matched = terms.filter((term) => text.includes(term));
    if (terms.length > 0) {
      entry.score += matched.length / terms.length * 0.01;
    }
    // A named organisation helps only when its page also matches the subject.
    const named = terms.filter((term) => entry.domain.split(/[.\-]/).includes(term));
    const subject = terms.filter((term) => !named.includes(term));
    if (named.length > 0 && subject.length > 0) {
      const alignment = subject.filter((term) => text.includes(term)).length / subject.length;
      entry.score += Math.min(alignment, 0.4) * 0.05;
    }
  }
  const candidates = [...entries.values()].sort((left, right) => right.score - left.score || left.result.url.localeCompare(right.result.url));
  const domains = new Map<string, number>();
  const results: SearchResult[] = [];
  for (const candidate of candidates) {
    const used = domains.get(candidate.domain) ?? 0;
    if (used >= 2) {
      continue;
    }
    results.push({ ...candidate.result, providers: [...candidate.providers].sort() });
    domains.set(candidate.domain, used + 1);
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}
