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

import type { EmbeddingsConfig } from "../config.js";

// node-llama-cpp is an optional dependency. Dynamically imported on first use
// so bryti can start without it (embeddings will be unavailable). Keep this
// typed locally so TypeScript builds do not require the optional package to be
// installed.
type Llama = any;
type LlamaEmbeddingContext = any;
type LlamaModel = any;

interface NodeLlamaCppModule {
  getLlama(options: {
    gpu: "auto";
    logger: (level: unknown, message: string) => void;
  }): Promise<Llama>;
  LlamaLogLevel: {
    warn: unknown;
    error: unknown;
    fatal: unknown;
  };
  resolveModelFile(uri: string, options: {
    directory?: string;
    cli: boolean;
    onProgress: (progress: { totalSize: number; downloadedSize: number }) => void;
  }): Promise<string>;
}

type EmbeddingInputType = "query" | "document";

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

let embeddingConfig: EmbeddingsConfig = { provider: "local", timeout_ms: 10000 };

/** Whether the configured embedding provider is available. Set once during first init attempt. */
let llmAvailable: boolean | null = null;

/**
 * Whether embeddings are available (node-llama-cpp loaded successfully).
 * Returns null before the first init attempt.
 */
export function configureEmbeddings(config: EmbeddingsConfig): void {
  embeddingConfig = config;
  if (config.provider === "openai-compatible") {
    llmAvailable = Boolean(config.base_url && config.model);
  }
}

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
    let nodeLlamaCpp: NodeLlamaCppModule;
    try {
      // Use a non-literal import specifier so TypeScript does not resolve the
      // optional dependency at compile time. Runtime behavior is unchanged.
      const moduleName = "node-llama-cpp";
      nodeLlamaCpp = await import(moduleName) as unknown as NodeLlamaCppModule;
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
function normalizeBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) throw new Error("Embedding base_url is required");
  return trimmed.replace(/\/+$/u, "");
}

function inputTypeFor(kind: EmbeddingInputType | undefined): string | undefined {
  if (kind === "query") return embeddingConfig.query_input_type ?? embeddingConfig.input_type;
  if (kind === "document") return embeddingConfig.document_input_type ?? embeddingConfig.input_type;
  return embeddingConfig.input_type;
}

async function embedRemote(text: string, kind?: EmbeddingInputType): Promise<number[] | null> {
  if (!embeddingConfig.model) throw new Error("Embedding model is required");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), embeddingConfig.timeout_ms);
  try {
    const body: Record<string, unknown> = {
      model: embeddingConfig.model,
      input: text,
    };
    if (embeddingConfig.dimensions !== undefined) body.dimensions = embeddingConfig.dimensions;
    const inputType = inputTypeFor(kind);
    if (inputType) body.input_type = inputType;

    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      ...(embeddingConfig.headers ?? {}),
    };
    if (embeddingConfig.api_key) headers.authorization = `Bearer ${embeddingConfig.api_key}`;

    const response = await fetch(`${normalizeBaseUrl(embeddingConfig.base_url)}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Embedding request failed: HTTP ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
    }

    const parsed = await response.json() as { data?: Array<{ embedding?: unknown }> };
    const embedding = parsed.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number")) {
      throw new Error("Embedding response did not contain a numeric embedding vector");
    }
    llmAvailable = true;
    return embedding;
  } catch (err) {
    llmAvailable = false;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function embed(
  text: string,
  modelsDir?: string,
  kind?: EmbeddingInputType,
): Promise<number[] | null> {
  if (!text.trim()) {
    throw new Error("Embedding input is empty");
  }

  if (embeddingConfig.provider === "openai-compatible") {
    return embedRemote(text, kind);
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
export async function embedBatch(
  texts: string[],
  modelsDir?: string,
  kind?: EmbeddingInputType,
): Promise<(number[] | null)[]> {
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
    results.push(await embed(text, modelsDir, kind));
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
  if (embeddingConfig.provider === "openai-compatible") {
    llmAvailable = Boolean(embeddingConfig.base_url && embeddingConfig.model);
    return;
  }
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
