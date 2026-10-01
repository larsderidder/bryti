import { parentPort, workerData } from "node:worker_threads";
import { createEngine, type PdfDocument } from "clawpdf";
import type { PdfResult } from "./pdf.js";

const input = workerData as { bytes: Uint8Array; wasmBinary: ArrayBuffer; maxPages: number; maxTextChars: number; renderImages: boolean };

/** Keep PDFium and its document lifetimes inside the disposable parser worker. */
async function extract(): Promise<PdfResult> {
  const engine = await createEngine({ wasmBinary: input.wasmBinary, maxRenderPixels: 2_000_000 });
  let document: PdfDocument | undefined;
  try {
    document = await engine.open(input.bytes);
    const result = await document.extract({ mode: "text", maxPages: input.maxPages, maxTextChars: Math.max(1, input.maxTextChars) });
    const lowTextPages: number[] = [];
    if (input.renderImages) {
      for (const page of result.pagesProcessed) {
        if (document.text({ pages: [page], maxChars: 51 }).trim().length < 50) {
          lowTextPages.push(page);
        }
      }
    }
    const images: PdfResult["images"] = [];
    let imageTruncated = false;
    if (input.renderImages && lowTextPages.length > 0) {
      const rendered = await document.extract({
        mode: "images", pages: lowTextPages.slice(0, 3), maxPages: 3,
        image: { dpi: 96, maxPixels: 2_000_000, maxDimension: 1800, forms: false },
      });
      imageTruncated = rendered.truncated.images;
      for (const image of rendered.images) {
        if (image.bytes.length <= 2_000_000) {
          images.push({ data: Buffer.from(image.bytes).toString("base64"), mimeType: "image/png" });
        } else {
          imageTruncated = true;
        }
      }
    }
    return { text: result.text.slice(0, input.maxTextChars), images,
      truncated: result.truncated.text || imageTruncated || result.text.length > input.maxTextChars || document.pageCount > input.maxPages || (input.renderImages && lowTextPages.length > 3) };
  } finally {
    document?.destroy();
    await engine.destroy();
  }
}

extract().then(
  (result) => parentPort!.postMessage({ result }),
  () => parentPort!.postMessage({ error: "PDF extraction failed" }),
);
