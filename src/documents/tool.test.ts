/**
 * Tests for the document tool layer.
 *
 * Uses a mock DocumentBackend — no HedgeDoc knowledge here.
 * Verifies that the tool layer correctly delegates to the backend,
 * wraps results in toolSuccess/toolError, and exposes stable tool names.
 */

import { describe, it, expect, vi } from "vitest";
import { createDocumentTools } from "./tool.js";
import type { DocumentBackend } from "./types.js";

function makeBackend(overrides: Partial<DocumentBackend> = {}): DocumentBackend {
  return {
    create: vi.fn().mockResolvedValue({ note_id: "abc123", url: "https://docs.example.com/abc123" }),
    update: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue("# Doc\n\nContent"),
    ...overrides,
  };
}

describe("createDocumentTools", () => {
  it("returns 3 tools with stable names", () => {
    const tools = createDocumentTools(makeBackend());
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["document_create", "document_update", "document_read"]);
  });
});

describe("document_create tool", () => {
  it("delegates to backend.create and returns note_id, url, title", async () => {
    const backend = makeBackend();
    const [create] = createDocumentTools(backend);

    const result = await create.execute("id", { title: "My Doc", content: "Hello" });
    const parsed = JSON.parse(result.content[0].text);

    expect(backend.create).toHaveBeenCalledWith("My Doc", "Hello");
    expect(parsed.note_id).toBe("abc123");
    expect(parsed.url).toBe("https://docs.example.com/abc123");
    expect(parsed.title).toBe("My Doc");
  });

  it("returns toolError when backend throws", async () => {
    const backend = makeBackend({ create: vi.fn().mockRejectedValue(new Error("network down")) });
    const [create] = createDocumentTools(backend);

    const result = await create.execute("id", { title: "X", content: "Y" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toMatch(/network down/);
  });
});

describe("document_update tool", () => {
  it("delegates to backend.update and returns updated: true", async () => {
    const backend = makeBackend();
    const [, update] = createDocumentTools(backend);

    const result = await update.execute("id", { note_id: "abc123", content: "new content" });
    const parsed = JSON.parse(result.content[0].text);

    expect(backend.update).toHaveBeenCalledWith("abc123", "new content");
    expect(parsed.updated).toBe(true);
    expect(parsed.note_id).toBe("abc123");
  });

  it("returns toolError when backend throws", async () => {
    const backend = makeBackend({ update: vi.fn().mockRejectedValue(new Error("timeout")) });
    const [, update] = createDocumentTools(backend);

    const result = await update.execute("id", { note_id: "abc123", content: "new" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toMatch(/timeout/);
  });
});

describe("document_read tool", () => {
  it("delegates to backend.read and returns content", async () => {
    const backend = makeBackend();
    const [,, read] = createDocumentTools(backend);

    const result = await read.execute("id", { note_id: "abc123" });
    const parsed = JSON.parse(result.content[0].text);

    expect(backend.read).toHaveBeenCalledWith("abc123");
    expect(parsed.note_id).toBe("abc123");
    expect(parsed.content).toBe("# Doc\n\nContent");
  });

  it("returns toolError when backend throws", async () => {
    const backend = makeBackend({ read: vi.fn().mockRejectedValue(new Error("not found")) });
    const [,, read] = createDocumentTools(backend);

    const result = await read.execute("id", { note_id: "abc123" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toMatch(/not found/);
  });
});
