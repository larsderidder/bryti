/**
 * Tests for the HedgeDoc backend implementation.
 *
 * Verifies HTTP calls, URL extraction, and markdown construction.
 * No tool layer involved — pure backend behaviour.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { HedgeDocBackend } from "./hedgedoc.js";

vi.mock("axios");
const mockedAxios = vi.mocked(axios, true);

const config = {
  url: "http://hedgedoc:3000",
  public_url: "https://docs.example.com",
};

describe("HedgeDocBackend.create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POSTs to /new and extracts note_id from Location header", async () => {
    mockedAxios.post = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: "/abc123" },
      data: "",
    });

    const backend = new HedgeDocBackend(config);
    const result = await backend.create("My Doc", "Hello world");

    expect(result.note_id).toBe("abc123");
    expect(result.url).toBe("https://docs.example.com/abc123");
  });

  it("uses public_url for the returned url", async () => {
    mockedAxios.post = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: "/xyz" },
      data: "",
    });

    const backend = new HedgeDocBackend({ url: "http://internal:3000", public_url: "https://public.example.com" });
    const result = await backend.create("T", "C");

    expect(result.url).toMatch("https://public.example.com/xyz");
  });

  it("falls back to url when public_url is not set", async () => {
    mockedAxios.post = vi.fn().mockResolvedValue({
      status: 302,
      headers: { location: "/xyz" },
      data: "",
    });

    const backend = new HedgeDocBackend({ url: "http://hedgedoc:3000" });
    const result = await backend.create("T", "C");

    expect(result.url).toMatch("http://hedgedoc:3000/xyz");
  });

  it("prepends H1 title when content does not start with one", async () => {
    let capturedBody = "";
    mockedAxios.post = vi.fn().mockImplementation((_url, body) => {
      capturedBody = body as string;
      return Promise.resolve({ status: 302, headers: { location: "/x" }, data: "" });
    });

    const backend = new HedgeDocBackend(config);
    await backend.create("Plan", "First step\nSecond step");

    expect(capturedBody).toMatch(/^# Plan\n\nFirst step/);
  });

  it("does not duplicate H1 when content already starts with one", async () => {
    let capturedBody = "";
    mockedAxios.post = vi.fn().mockImplementation((_url, body) => {
      capturedBody = body as string;
      return Promise.resolve({ status: 302, headers: { location: "/x" }, data: "" });
    });

    const backend = new HedgeDocBackend(config);
    await backend.create("Plan", "# Plan\n\nContent");

    expect(capturedBody).not.toMatch(/^# Plan\n\n# Plan/);
    expect(capturedBody).toMatch(/^# Plan\n\nContent/);
  });

  it("throws when no Location header is returned", async () => {
    mockedAxios.post = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: "" });

    const backend = new HedgeDocBackend(config);
    await expect(backend.create("X", "Y")).rejects.toThrow("HedgeDoc did not return a note location");
  });

  it("propagates network errors", async () => {
    mockedAxios.post = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const backend = new HedgeDocBackend(config);
    await expect(backend.create("X", "Y")).rejects.toThrow("ECONNREFUSED");
  });
});

describe("HedgeDocBackend.update", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POSTs to /new/<noteId> with new content", async () => {
    let calledUrl = "";
    mockedAxios.post = vi.fn().mockImplementation((url) => {
      calledUrl = url as string;
      return Promise.resolve({ status: 302, headers: { location: "/abc123" }, data: "" });
    });

    const backend = new HedgeDocBackend(config);
    await backend.update("abc123", "# Updated\n\nNew content");

    expect(calledUrl).toBe("http://hedgedoc:3000/new/abc123");
  });

  it("resolves without error on success", async () => {
    mockedAxios.post = vi.fn().mockResolvedValue({ status: 302, headers: {}, data: "" });

    const backend = new HedgeDocBackend(config);
    await expect(backend.update("abc123", "new")).resolves.toBeUndefined();
  });

  it("propagates network errors", async () => {
    mockedAxios.post = vi.fn().mockRejectedValue(new Error("timeout"));

    const backend = new HedgeDocBackend(config);
    await expect(backend.update("abc123", "new")).rejects.toThrow("timeout");
  });
});

describe("HedgeDocBackend.read", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GETs /<noteId>/download and returns content", async () => {
    let calledUrl = "";
    mockedAxios.get = vi.fn().mockImplementation((url) => {
      calledUrl = url as string;
      return Promise.resolve({ status: 200, data: "# My Doc\n\nContent here" });
    });

    const backend = new HedgeDocBackend(config);
    const content = await backend.read("abc123");

    expect(calledUrl).toBe("http://hedgedoc:3000/abc123/download");
    expect(content).toBe("# My Doc\n\nContent here");
  });

  it("coerces non-string data to string", async () => {
    mockedAxios.get = vi.fn().mockResolvedValue({ status: 200, data: 42 });

    const backend = new HedgeDocBackend(config);
    const content = await backend.read("abc123");

    expect(content).toBe("42");
  });

  it("propagates network errors", async () => {
    mockedAxios.get = vi.fn().mockRejectedValue(new Error("404"));

    const backend = new HedgeDocBackend(config);
    await expect(backend.read("abc123")).rejects.toThrow("404");
  });
});
