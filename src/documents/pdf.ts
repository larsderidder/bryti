import fs from "node:fs";
import { Worker } from "node:worker_threads";
import type { DocumentAttachment } from "../channels/types.js";
import { capWasmMemory } from "./wasm-memory.js";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_WASM_BYTES = 128 * 1024 * 1024;
export interface PdfOptions {
  maxBytes?: number;
  maxPages?: number;
  maxTextChars?: number;
  renderImages?: boolean;
  timeoutMs?: number;
}
export interface PdfResult {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  truncated: boolean;
}

let activeWorkers = 0;
let boundedWasm: ArrayBuffer | undefined;

/** Parse attachment bytes locally in a terminable worker with bounded input and output. */
export async function extractPdfAttachment(attachment: DocumentAttachment, options: PdfOptions = {}, signal?: AbortSignal): Promise<PdfResult> {
  signal?.throwIfAborted();
  const maxBytes = options.maxBytes ?? MAX_PDF_BYTES;
  const maxPages = options.maxPages ?? 20;
  const maxTextChars = options.maxTextChars ?? 40_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PDF_BYTES
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20
    || !Number.isSafeInteger(maxTextChars) || maxTextChars < 0 || maxTextChars > 40_000
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Invalid PDF extraction limits");
  }
  if (attachment.data.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error("PDF exceeds the byte limit");
  }
  const bytes = Buffer.from(attachment.data, "base64");
  if (bytes.length > maxBytes) {
    throw new Error("PDF exceeds the byte limit");
  }
  if (attachment.mimeType !== "application/pdf" || !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new Error("Attachment is not a PDF");
  }
  if (activeWorkers >= 2) {
    throw new Error("PDF extraction is busy; try again shortly");
  }
  let workerUrl = new URL("./pdf-worker.js", import.meta.url);
  if (!fs.existsSync(workerUrl)) {
    workerUrl = new URL("./pdf-worker.ts", import.meta.url);
  }
  if (!boundedWasm) {
    const binary = fs.readFileSync(new URL("./vendor/pdfium.esm.wasm", import.meta.resolve("clawpdf")));
    boundedWasm = capWasmMemory(binary, MAX_WASM_BYTES / 65_536);
  }
  const worker = new Worker(workerUrl, {
    workerData: { bytes, wasmBinary: boundedWasm, maxPages, maxTextChars, renderImages: options.renderImages === true },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
    execArgv: [],
  });
  activeWorkers += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (error?: Error, result?: PdfResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      try {
        await worker.terminate();
      } catch {
        error ??= new Error("PDF extraction worker could not be stopped");
      } finally {
        activeWorkers -= 1;
      }
      if (error) {
        reject(error);
      } else {
        resolve(result!);
      }
    };
    const abort = () => { void finish(new DOMException("PDF extraction cancelled", "AbortError")); };
    const timer = setTimeout(() => { void finish(new Error("PDF extraction timed out")); }, timeoutMs);
    worker.once("message", (reply: { result?: PdfResult; error?: string }) => {
      if (reply.error || !reply.result) {
        void finish(new Error("PDF could not be extracted; it may be invalid or encrypted"));
      } else {
        void finish(undefined, reply.result);
      }
    });
    worker.once("error", (error) => { void finish(error); });
    worker.once("exit", () => {
      if (!settled) {
        void finish(new Error("PDF extraction worker exited without a result"));
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
  });
}
