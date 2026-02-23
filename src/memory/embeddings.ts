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
 *
 * When node-llama-cpp is not installed, embed() returns null and all callers
 * degrade to keyword-only search. This keeps bryti functional without native
 * build tools.
 */

// node-llama-cpp is an optional dependency. Dynamically imported on first use
// so bryti can start without it (embeddings will be unavailable).
type Llama = any;
type LlamaEmbeddingContext = any;
type LlamaModel = any;

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
let initPromise: Promise<LlamaEmbeddingContext | null> | null = null;

/** Whether node-llama-cpp is available. Set once during first init attempt. */
let llmAvailable: boolean | null = null;

/**
 * Whether embeddings are available (node-llama-cpp loaded successfully).
 * Returns null before the first init attempt.
 */
export function embeddingsAvailable(): boolean | null {
  return llmAvailable;
}

/**
 * Initialize and return the embedding context, loading the model on first call.
 * Returns null if node-llama-cpp is not installed.
 */
async function getEmbeddingContext(modelsDir?: string): Promise<LlamaEmbeddingContext | null> {
  if (llmAvailable === false) {
    return null;
  }

  if (embeddingContext !== null) {
    return embeddingContext;
  }

  if (initPromise !== null) {
    return initPromise;
  }

  initPromise = (async () => {
    let nodeLlamaCpp: typeof import("node-llama-cpp");
    try {
      nodeLlamaCpp = await import("node-llama-cpp");
    } catch {
      llmAvailable = false;
      console.warn(
        "[embeddings] node-llama-cpp not installed. " +
        "Archival memory will use keyword search only (no vector similarity). " +
        "Install it with: npm install node-llama-cpp",
      );
      return null;
    }
    const { getLlama, LlamaLogLevel, resolveModelFile } = nodeLlamaCpp;

    const llama = await getLlama({
      gpu: "auto",
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
    llmAvailable = true;
    return ctx;
  })();

  return initPromise;
}

/**
 * Generate an embedding for a single text.
 * Returns null if node-llama-cpp is not installed.
 */
export async function embed(text: string, modelsDir?: string): Promise<number[] | null> {
  if (!text.trim()) {
    throw new Error("Embedding input is empty");
  }

  const ctx = await getEmbeddingContext(modelsDir);
  if (ctx === null) {
    return null;
  }

  const result = await ctx.getEmbeddingFor(text);
  return Array.from(result.vector);
}

/**
 * Generate embeddings for multiple texts. Sequential; the model is fast
 * enough on CPU that batching provides no meaningful advantage.
 * Returns null entries for each text if node-llama-cpp is not installed.
 */
export async function embedBatch(texts: string[], modelsDir?: string): Promise<(number[] | null)[]> {
  if (texts.length === 0) {
    return [];
  }

  for (const text of texts) {
    if (!text.trim()) {
      throw new Error("Embedding input is empty");
    }
  }

  const results: (number[] | null)[] = [];
  for (const text of texts) {
    results.push(await embed(text, modelsDir));
  }
  return results;
}

/**
 * Pre-load the embedding model at startup.
 *
 * Best-effort: if node-llama-cpp is not installed, logs a warning and
 * continues. Bryti still works with keyword-only search.
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
