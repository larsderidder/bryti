/** Validate the built parser and worker entrypoint with local PDF fixtures. */
import assert from "node:assert/strict";
import { extractPdfAttachment } from "../dist/documents/pdf.js";
import { fixturePdf } from "../dist/documents/__fixtures__/pdf.js";

const text = await extractPdfAttachment({ data: fixturePdf("Compiled PDF parser fixture"), mimeType: "application/pdf" });
assert.match(text.text, /Compiled PDF parser fixture/);
assert.deepEqual(text.images, []);

const scanned = await extractPdfAttachment({ data: fixturePdf(""), mimeType: "application/pdf" }, { renderImages: true });
assert.equal(scanned.images.length, 1);
assert.equal(scanned.images[0].mimeType, "image/png");
assert.equal(Buffer.from(scanned.images[0].data, "base64").subarray(1, 4).toString(), "PNG");
console.log(JSON.stringify({ compiledPdfWorker: "passed", pageImages: scanned.images.length }));
