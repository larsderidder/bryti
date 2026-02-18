/**
 * Local embeddings via node-llama-cpp.
 *
 * Uses a small GGUF embedding model downloaded on first use.
 * No external API key required.
 *
 * The model and embedding context are loaded once and reused across calls.
 * Model files are stored in `<dataDir>/.models/`.
 */

import { getLlama, resolveModelFile } from "node-llama-cpp";
import type { LlamaEmbeddingContext } from "node-llama-cpp";

const EMBEDDING_MODEL_URI =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

let embeddingContext: LlamaEmbeddingContext | null = null;
let initPromise: Promise<LlamaEmbeddingContext> | null = null;

/**
 * Initialize and return the embedding context, loading the model on first call.
 * Subsequent calls return the cached context.
 */
async function getEmbeddingContext(modelsDir?: string): Promise<LlamaEmbeddingContext> {
  if (embeddingContext !== null) {
    return embeddingContext;
  }

  if (initPromise !== null) {
    return initPromise;
  }

  initPromise = (async () => {
    const llama = await getLlama({ gpu: "auto" });

    const modelPath = await resolveModelFile(EMBEDDING_MODEL_URI, {
      directory: modelsDir,
      cli: false,
      onProgress({ totalSize, downloadedSize }) {
        const pct = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
        process.stdout.write(`\rDownloading embedding model: ${pct}%`);
      },
    });
    process.stdout.write("\n");

    const model = await llama.loadModel({ modelPath });
    const ctx = await model.createEmbeddingContext();

    embeddingContext = ctx;
    return ctx;
  })();

  return initPromise;
}

/**
 * Generate an embedding for a single text.
 *
 * @param text Input text (must be non-empty)
 * @param modelsDir Directory to store/load the model (defaults to node-llama-cpp global dir)
 */
export async function embed(text: string, modelsDir?: string): Promise<number[]> {
  if (!text.trim()) {
    throw new Error("Embedding input is empty");
  }

  const ctx = await getEmbeddingContext(modelsDir);
  const result = await ctx.getEmbeddingFor(text);
  return Array.from(result.vector);
}

/**
 * Generate embeddings for multiple texts.
 * Calls embed() sequentially; the model is fast enough on CPU that batching
 * provides no meaningful advantage here.
 *
 * @param texts Array of input texts (each must be non-empty)
 * @param modelsDir Directory to store/load the model
 */
export async function embedBatch(texts: string[], modelsDir?: string): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  for (const text of texts) {
    if (!text.trim()) {
      throw new Error("Embedding input is empty");
    }
  }

  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embed(text, modelsDir));
  }
  return results;
}

/**
 * Pre-load the embedding model. Call this at startup to avoid latency on the
 * first memory operation.
 *
 * @param modelsDir Directory to store/load the model
 */
export async function warmupEmbeddings(modelsDir?: string): Promise<void> {
  await getEmbeddingContext(modelsDir);
}
