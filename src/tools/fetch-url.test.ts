import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { basename } from "node:path";
import axios from "axios";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

import { createFetchUrlTool } from "./fetch-url.js";

const mockedAxios = vi.mocked(axios);

const readableHtml = `
<html>
  <head><title>Hello</title></head>
  <body>
    <article>
      <h1>Hello</h1>
      <p>Readable page text with enough words to make the extractor happy.</p>
      <p>This second paragraph makes the article look like real content.</p>
    </article>
  </body>
</html>`;

describe("createFetchUrlTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ARGUS_AUTHORITY_URL", undefined);
    vi.stubEnv("ARGUS_ENV", undefined);
    vi.stubEnv("ARGUS_MCP_STANDALONE", undefined);
    vi.stubEnv("ARGUS_DATA_ROOT", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires HTTPS by default", async () => {
    const tool = createFetchUrlTool();
    const result = await tool.execute("id", { url: "http://example.com" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain("Blocked URL scheme: http:");
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("blocks private URLs before extraction", async () => {
    const tool = createFetchUrlTool();
    const result = await tool.execute("id", { url: "https://127.0.0.1/admin" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain("Blocked non-public IP address");
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("uses npm-native Readability by default", async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: readableHtml });

    const tool = createFetchUrlTool();
    const result = await tool.execute("id", { url: "https://93.184.216.34/article" });

    expect(result.content[0].text).toContain("# Hello");
    expect(result.content[0].text).toContain("Readable page text");
    expect(result.content[0].text).toContain("untrusted external data");
    expect(result.details?.backend).toBe("readability");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://93.184.216.34/article",
      expect.objectContaining({
        maxRedirects: 5,
        lookup: expect.any(Function),
      }),
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("extracts readable text through Argus when configured", async () => {
    execFileMock.mockImplementationOnce((_bin, _args, _options, callback) => {
      callback(null, JSON.stringify({
        title: "Hello",
        url: "https://93.184.216.34/article",
        text: "Readable page text.",
        extractor: "argus-readability",
        word_count: 3,
      }), "");
    });

    const tool = createFetchUrlTool(45000, {
      backend: "argus",
      argusBin: "argus-test",
      searxngUrl: "https://search.example.com",
    });
    const result = await tool.execute("id", { url: "https://93.184.216.34/article" });

    expect(result.content[0].text).toContain("# Hello");
    expect(result.content[0].text).toContain("Readable page text.");
    expect(result.details?.backend).toBe("argus");
    expect(mockedAxios.get).not.toHaveBeenCalled();
    const [bin, args, options] = execFileMock.mock.calls[0];
    expect(bin).toBe("argus-test");
    expect(args).toEqual(["extract", "-u", "https://93.184.216.34/article", "--json"]);
    expect(options.timeout).toBe(45000);
    expect(options.env.ARGUS_SEARXNG_BASE_URL).toBe("https://search.example.com");
    expect(options.env.ARGUS_SEARXNG_ENABLED).toBe("true");
    expect(options.env.ARGUS_MCP_STANDALONE).toBe("true");
    expect(basename(options.env.ARGUS_DATA_ROOT)).toBe("argus-cli");
  });

  it.each([
    { authority: undefined, environment: undefined, standalone: undefined, expected: "true" },
    { authority: "http://127.0.0.1:8271", environment: undefined, standalone: undefined, expected: undefined },
    { authority: undefined, environment: " PRODUCTION ", standalone: undefined, expected: undefined },
    { authority: undefined, environment: undefined, standalone: "false", expected: "false" },
    { authority: undefined, environment: undefined, standalone: "true", root: "/tmp/operator-argus", expected: "true" },
  ])("preserves Argus execution configuration: $authority, $environment, $standalone", async (config) => {
    vi.stubEnv("ARGUS_AUTHORITY_URL", config.authority);
    vi.stubEnv("ARGUS_ENV", config.environment);
    vi.stubEnv("ARGUS_MCP_STANDALONE", config.standalone);
    vi.stubEnv("ARGUS_DATA_ROOT", config.root);
    execFileMock.mockImplementationOnce((_bin, _args, _options, callback) => {
      callback(null, JSON.stringify({ title: "T", text: "Content." }), "");
    });

    const tool = createFetchUrlTool(45000, { backend: "argus" });
    await tool.execute("id", { url: "https://93.184.216.34/article" });

    expect(execFileMock.mock.calls[0][2].env.ARGUS_MCP_STANDALONE).toBe(config.expected);
    const root = execFileMock.mock.calls[0][2].env.ARGUS_DATA_ROOT;
    if (config.root) {
      expect(root).toBe(config.root);
    } else if (config.expected === "true") {
      expect(basename(root)).toBe("argus-cli");
    } else {
      expect(root).toBeUndefined();
    }
  });

  it("passes optional Argus domain, mode, and max_chars arguments", async () => {
    execFileMock.mockImplementationOnce((_bin, _args, _options, callback) => {
      callback(null, JSON.stringify({ title: "T", text: "x".repeat(2000) }), "");
    });

    const tool = createFetchUrlTool(45000, { backend: "argus" });
    const result = await tool.execute("id", {
      url: "https://93.184.216.34/article",
      domain: "example.com",
      mode: "archive_ingest",
      max_chars: 1000,
    });

    expect(execFileMock.mock.calls[0][1]).toEqual([
      "extract",
      "-u",
      "https://93.184.216.34/article",
      "--json",
      "-d",
      "example.com",
      "-m",
      "archive_ingest",
    ]);
    expect(result.content[0].text).toContain("[...output truncated]");
  });

  it("can allow HTTP when explicitly configured", async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: readableHtml });

    const tool = createFetchUrlTool(45000, { requireHttps: false });
    const result = await tool.execute("id", { url: "http://93.184.216.34/article" });

    expect(result.content[0].text).toContain("Readable page text");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "http://93.184.216.34/article",
      expect.any(Object),
    );
  });
});
