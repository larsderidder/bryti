import { describe, expect, it } from "vitest";
import { extractPdfAttachment } from "./pdf.js";

import { fixturePdf } from "./__fixtures__/pdf.js";

describe("local PDF worker", () => {
  it("extracts a PDF without a remote service", async () => {
    const result = await extractPdfAttachment({ data: fixturePdf("Local PDF example"), mimeType: "application/pdf", fileName: "example.pdf" });
    expect(result.text).toContain("Local PDF example");
    expect(result.images).toEqual([]);
  });

  it("caps extracted text", async () => {
    const result = await extractPdfAttachment({ data: fixturePdf("x".repeat(200)), mimeType: "application/pdf" }, { maxTextChars: 40 });
    expect(result.text.length).toBeLessThanOrEqual(40);
    expect(result.truncated).toBe(true);
  });

  it("optionally renders a page without usable text", async () => {
    const result = await extractPdfAttachment({ data: fixturePdf(""), mimeType: "application/pdf" }, { renderImages: true });
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
    expect(Buffer.from(result.images[0].data, "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  it("rejects oversized input before starting a worker", async () => {
    await expect(extractPdfAttachment({ data: fixturePdf("Example"), mimeType: "application/pdf" }, { maxBytes: 10 })).rejects.toThrow("byte limit");
  });

  it("rejects invalid PDFs", async () => {
    await expect(extractPdfAttachment({ data: Buffer.from("not a PDF").toString("base64"), mimeType: "application/pdf" })).rejects.toThrow("PDF");
  });

  it("does not start extraction after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(extractPdfAttachment({ data: fixturePdf("Example"), mimeType: "application/pdf" }, {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("terminates an active worker after cancellation and releases its slot", async () => {
    const controller = new AbortController();
    const attachment = { data: fixturePdf("Local example"), mimeType: "application/pdf" as const };
    const pending = extractPdfAttachment(attachment, {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect((await extractPdfAttachment(attachment)).text).toContain("Local example");
  });

  it("enforces a deadline and releases the worker slot", async () => {
    const attachment = { data: fixturePdf("Local example"), mimeType: "application/pdf" as const };
    await expect(extractPdfAttachment(attachment, { timeoutMs: 1 })).rejects.toThrow("timed out");
    expect((await extractPdfAttachment(attachment)).text).toContain("Local example");
  });

  it("handles an exhausted text budget without returning further text", async () => {
    const result = await extractPdfAttachment({ data: fixturePdf("Local example"), mimeType: "application/pdf" }, { maxTextChars: 0 });
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
  });

  it.each([{ maxPages: NaN }, { maxPages: 21 }, { maxTextChars: -1 }, { maxBytes: Infinity }, { timeoutMs: 0 }])(
    "rejects invalid extraction limits %j before worker creation", async (options) => {
      await expect(extractPdfAttachment({ data: fixturePdf("Example"), mimeType: "application/pdf" }, options)).rejects.toThrow("extraction limits");
    },
  );
});
