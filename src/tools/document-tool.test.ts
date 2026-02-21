/**
 * Tests for document tools (HedgeDoc backend).
 *
 * Uses a mock axios to avoid network calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { createDocumentTools } from "./document-tool.js";

vi.mock("axios");
const mockedAxios = vi.mocked(axios, true);

const config = {
  url: "http://hedgedoc:3000",
  public_url: "https://docs.example.com",
};

function getTools() {
  const tools = createDocumentTools(config);
  const create = tools.find((t) => t.name === "document_create")!;
  const update = tools.find((t) => t.name === "document_update")!;
  const read = tools.find((t) => t.name === "document_read")!;
  return { create, update, read };
}

describe("createDocumentTools", () => {
  it("returns empty array when config is undefined", () => {
    expect(createDocumentTools(undefined)).toHaveLength(0);
  });

  it("returns 3 tools when config is provided", () => {
    expect(createDocumentTools(config)).toHaveLength(3);
  });
});

describe("document_create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a note and returns url with public_url base", async () => {
    mockedAxios.post = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: "/abc123" },
      data: "",
    });

    const { create } = getTools();
    const result = await create.execute("id", { title: "My Doc", content: "Hello world" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.note_id).toBe("abc123");
    expect(parsed.url).toBe("https://docs.example.com/abc123");
    expect(parsed.title).toBe("My Doc");
  });

  it("prepends H1 title when content does not start with one", async () => {
    let capturedBody = "";
    mockedAxios.post = vi.fn().mockImplementation((_url, body) => {
      capturedBody = body;
      return Promise.resolve({ status: 302, headers: { location: "/xyz" }, data: "" });
    });

    const { create } = getTools();
    await create.execute("id", { title: "Plan", content: "First step\nSecond step" });

    expect(capturedBody).toMatch(/^# Plan\n\nFirst step/);
  });

  it("does not duplicate H1 when content already starts with one", async () => {
    let capturedBody = "";
    mockedAxios.post = vi.fn().mockImplementation((_url, body) => {
      capturedBody = body;
      return Promise.resolve({ status: 302, headers: { location: "/xyz" }, data: "" });
    });

    const { create } = getTools();
    await create.execute("id", { title: "Plan", content: "# Plan\n\nContent" });

    expect(capturedBody).not.toMatch(/^# Plan\n\n# Plan/);
    expect(capturedBody).toMatch(/^# Plan\n\nContent/);
  });

  it("returns error when no location header", async () => {
    mockedAxios.post = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: "" });

    const { create } = getTools();
    const result = await create.execute("id", { title: "X", content: "Y" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBeDefined();
  });

  it("returns error on network failure", async () => {
    mockedAxios.post = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const { create } = getTools();
    const result = await create.execute("id", { title: "X", content: "Y" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toMatch(/ECONNREFUSED/);
  });
});

describe("document_update", () => {
  beforeEach(() => vi.clearAllMocks());

  it("posts to /new/<noteId> with new content", async () => {
    let calledUrl = "";
    mockedAxios.post = vi.fn().mockImplementation((url) => {
      calledUrl = url;
      return Promise.resolve({ status: 302, headers: { location: "/abc123" }, data: "" });
    });

    const { update } = getTools();
    await update.execute("id", { note_id: "abc123", content: "# Updated\n\nNew content" });

    expect(calledUrl).toBe("http://hedgedoc:3000/new/abc123");
  });

  it("returns updated: true on success", async () => {
    mockedAxios.post = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: "/abc123" },
      data: "",
    });

    const { update } = getTools();
    const result = await update.execute("id", { note_id: "abc123", content: "new" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.updated).toBe(true);
    expect(parsed.note_id).toBe("abc123");
  });

  it("returns error on failure", async () => {
    mockedAxios.post = vi.fn().mockRejectedValue(new Error("timeout"));

    const { update } = getTools();
    const result = await update.execute("id", { note_id: "abc123", content: "new" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toMatch(/timeout/);
  });
});

describe("document_read", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches /<noteId>/download and returns content", async () => {
    let calledUrl = "";
    mockedAxios.get = vi.fn().mockImplementation((url) => {
      calledUrl = url;
      return Promise.resolve({ status: 200, data: "# My Doc\n\nContent here" });
    });

    const { read } = getTools();
    const result = await read.execute("id", { note_id: "abc123" });
    const parsed = JSON.parse(result.content[0].text);

    expect(calledUrl).toBe("http://hedgedoc:3000/abc123/download");
    expect(parsed.content).toBe("# My Doc\n\nContent here");
    expect(parsed.note_id).toBe("abc123");
  });

  it("returns error on failure", async () => {
    mockedAxios.get = vi.fn().mockRejectedValue(new Error("404"));

    const { read } = getTools();
    const result = await read.execute("id", { note_id: "abc123" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toMatch(/404/);
  });
});
