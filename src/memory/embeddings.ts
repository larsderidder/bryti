/**
 * Local embeddings via node-llama-cpp.
 *
 * Uses a small GGUF embedding model downloaded on first use; no external
 * API key required. The model and context are loaded once and reused across
 * calls. Model files live in <dataDir>/.models/.
 */

import { getLlama, LlamaLogLevel, resolveModelFile } from "node-llama-cpp";
import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";

const EMBEDDING_MODEL_URI =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

let llamaInstance: Llama | null = null;
let llamaModel: LlamaModel | null = null;
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
    const llama = await getLlama({
      gpu: "auto",
      // Suppress noisy tokenizer metadata warnings from the embedding model GGUF
      logger(level, message) {
        if (level === LlamaLogLevel.warn && message.includes("special_eos_id is not in special_eog_ids")) {
          return;
        }
        if (level === LlamaLogLevel.error || level === LlamaLogLevel.fatal) {
          console.error("[llama]", message);
        }
      },
    });
    llamaInstance = llama;

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
    llamaModel = model;
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
 * Generate embeddings for multiple texts. Sequential; the model is fast
 * enough on CPU that batching provides no meaningful advantage.
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

/**
 * Release the embedding context, model, and llama instance. Call during
 * shutdown so node-llama-cpp's native threads exit and Node doesn't hang.
 */
export async function disposeEmbeddings(): Promise<void> {
  if (embeddingContext) {
    await embeddingContext.dispose();
    embeddingContext = null;
  }
  if (llamaModel) {
    await llamaModel.dispose();
    llamaModel = null;
  }
  if (llamaInstance) {
    await llamaInstance.dispose();
    llamaInstance = null;
  }
  initPromise = null;
}
