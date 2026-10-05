import { expect, it } from "vitest";
import { mergeSearchResults, type SearchResult } from "./search-results.js";

const guide = (url: string): SearchResult => ({ title: "Guide", url, snippet: "Guide evidence" });

it("deduplicates tracking and HTTP aliases while retaining both providers", () => {
  const results = mergeSearchResults([
    { provider: "parallel", results: [guide("http://www.example.org/guide/?utm_source=search")] },
    { provider: "searxng", results: [guide("https://example.org/guide#section")] },
  ], "guide", 3);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ url: "https://example.org/guide#section", providers: ["parallel", "searxng"] });
});

it("does not collapse distinct semantic query parameters", () => {
  const results = mergeSearchResults([{ provider: "parallel", results: [guide("https://example.org/?page=1"), guide("https://example.org/?page=2")] }], "guide", 3);
  expect(results).toHaveLength(2);
});

it("does not let a duplicated URL outvote cross-provider agreement", () => {
  const repeated = guide("https://duplicate.org/");
  const shared = guide("https://shared.org/");
  const results = mergeSearchResults([
    { provider: "parallel", results: [repeated, repeated, shared] },
    { provider: "searxng", results: [shared] },
  ], "guide", 1);
  expect(results[0].url).toBe(shared.url);
});

it("can retain a relevant named organisation beyond the requested result count", () => {
  const commercial = guide("https://commercial.org/");
  const official = { title: "ISDE warmtepomp subsidie", url: "https://www.rvo.nl/isde/warmtepomp", snippet: "Warmtepomp subsidie 2026" };
  const results = mergeSearchResults([
    { provider: "parallel", results: [commercial] },
    { provider: "searxng", results: [commercial, guide("https://other.org/"), official] },
  ], "RVO ISDE warmtepomp subsidie 2026", 1);
  expect(results[0].url).toBe(official.url);
});

it("does not promote a named organisation without a matching subject", () => {
  const relevant = { title: "Warmtepomp subsidie 2026", url: "https://relevant.org/", snippet: "ISDE warmtepomp subsidie" };
  const results = mergeSearchResults([{ provider: "parallel", results: [relevant, { title: "Contact", url: "https://www.rvo.nl/contact", snippet: "Contactgegevens" }] }], "RVO ISDE warmtepomp subsidie 2026", 1);
  expect(results[0].url).toBe(relevant.url);
});

it("bounds the final result count and one domain's representation", () => {
  const results = mergeSearchResults([{ provider: "parallel", results: [guide("https://example.org/1"), guide("https://example.org/2"), guide("https://example.org/3"), guide("https://other.org/")] }], "guide", 3);
  expect(results).toHaveLength(3);
  expect(results.filter((result) => new URL(result.url).hostname === "example.org")).toHaveLength(2);
});

it("does not mutate input results when choosing richer snippets", () => {
  const original = Object.freeze(guide("https://example.org/"));
  const richer = { ...original, snippet: "A richer and much longer explanation of the guide" };
  const results = mergeSearchResults([{ provider: "parallel", results: [original] }, { provider: "searxng", results: [richer] }], "guide", 1);
  expect(results[0].snippet).toBe(richer.snippet);
  expect(original.snippet).toBe("Guide evidence");
});

it("ignores malformed URLs and credential-bearing results", () => {
  const results = mergeSearchResults([{ provider: "parallel", results: [guide("not a URL"), guide("ftp://example.org/"), guide("https://user:fixture@example.org/")] }], "guide", 3);
  expect(results).toEqual([]);
});

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("returns no results for an invalid count %s", (count) => {
  expect(mergeSearchResults([{ provider: "parallel", results: [guide("https://example.org/")] }], "guide", count)).toEqual([]);
});
