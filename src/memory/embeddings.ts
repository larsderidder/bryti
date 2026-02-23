/**
 * Local embeddings via node-llama-cpp.
 *
 * Singleton pattern: one Llama instance, one model, one embedding context,
 * shared across all calls for the lifetime of the process. The model weighs
 * 300MB+, so loading it per-call or per-request is not viable. Instead,
 * getEmbeddingContext() initialises everything on first call and caches the
 * result; every subsequent call returns the cached context immediately.
 *
 * Model files live in <dataDir>/.models/.
 */

import { getLlama, LlamaLogLevel, resolveModelFile } from "node-llama-cpp";
import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";

// Hugging Face URI in node-llama-cpp's "hf:<owner>/<repo>/<file>" format.
// On first use, node-llama-cpp resolves this automatically: it locates (or
// downloads) the file and caches it in the modelsDir supplied at init time.
const EMBEDDING_MODEL_URI =
  "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

let llamaInstance: Llama | null = null;
let llamaModel: LlamaModel | null = null;
let embeddingContext: LlamaEmbeddingContext | null = null;
// In-flight initialisation guard. Without this, concurrent calls to
// getEmbeddingContext() before the first load completes would each kick off a
// separate model load. Storing the Promise here means every concurrent caller
// awaits the same in-progress load instead of starting a new one.
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
      logger(level, message) {
        // 'special_eos_id is not in special_eog_ids' is a benign metadata quirk
        // in the embedding model's GGUF file: the end-of-sequence token id is
        // not listed in the end-of-generation set. It has no effect on embedding
        // quality and is safe to ignore.
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
 * Pre-load the embedding model at startup.
 *
 * Calling this eagerly means a missing or corrupt model file surfaces as a
 * startup error rather than failing silently on the first user message that
 * triggers a memory operation. Also amortises the cold-start download/load
 * time before any user is waiting.
 *
 * @param modelsDir Directory to store/load the model
 */
export async function warmupEmbeddings(modelsDir?: string): Promise<void> {
  await getEmbeddingContext(modelsDir);
}

/**
 * Release the embedding context, model, and Llama instance.
 *
 * Call this on graceful shutdown. node-llama-cpp allocates native (non-GC)
 * resources for model weights and inference threads; skipping dispose leaves
 * those resources live until the OS reclaims them, and can prevent the Node
 * process from exiting cleanly.
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
