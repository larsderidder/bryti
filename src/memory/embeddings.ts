/**
 * Local embedding provider using nomic-embed-text-v1.
 *
 * Supports multiple backends:
 * - Local: transformers.js (browser-compatible) or a dedicated embedding library
 * - API: OpenAI, Cohere, etc. as fallback
 *
 * Single instance shared across all users.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface EmbeddingProvider {
  /** Generate embeddings for a single text. */
  embed(text: string): Promise<number[]>;

  /** Generate embeddings for multiple texts. */
  embedBatch(texts: string[]): Promise<number[][]>;

  /** Embedding dimension (768 for nomic-embed-text-v1). */
  readonly dims: number;

  /** Check if the provider is ready. */
  readonly ready: boolean;

  /** Provider name for logging/debugging. */
  readonly providerName: string;

  /** Clean up resources. */
  close(): void;
}

export interface EmbeddingConfig {
  /** Type of embedding provider: "local" or "api" */
  type: "local" | "api";
  
  /** For local: path to model file or directory */
  modelPath?: string;
  
  /** For API: provider name (openai, cohere, etc.) */
  apiProvider?: string;
  
  /** For API: API key */
  apiKey?: string;
}

/**
 * Create an embedding provider based on configuration.
 */
export async function createEmbeddingProvider(
  config: EmbeddingConfig,
): Promise<EmbeddingProvider> {
  if (config.type === "local") {
    return createLocalEmbeddingProvider(config.modelPath);
  } else {
    return createApiEmbeddingProvider(config.apiProvider!, config.apiKey!);
  }
}

/**
 * Create a local embedding provider using transformers.js or similar.
 * 
 * For now, this creates a provider that loads the model from disk.
 * The actual embedding computation uses a simple token-based approach
 * that can be replaced with proper transformer embeddings later.
 */
async function createLocalEmbeddingProvider(
  modelsDir?: string,
): Promise<EmbeddingProvider> {
  const defaultModelsDir = path.join(process.cwd(), "models");
  const modelDir = modelsDir || defaultModelsDir;
  const modelPath = path.join(modelDir, "nomic-embed-text-v1.gguf");

  // nomic-embed-text-v1 produces 768-dimensional embeddings
  const DIMS = 768;
  let isReady = false;

  // Try to initialize the local model
  // For now, we'll use a simple hash-based embedding as placeholder
  // until proper transformer support is added
  console.log(`[Embedding] Initializing local embedding provider`);
  console.log(`[Embedding] Model path: ${modelPath}`);

  // Check if model exists
  if (!fs.existsSync(modelPath)) {
    console.warn(`[Embedding] Model not found at ${modelPath}`);
    console.warn(`[Embedding] Using hash-based embeddings as fallback`);
  }

  // Simple hash-based embedding for development/testing
  // This produces deterministic vectors but lacks semantic meaning
  // Replace with actual transformer embeddings for production
  function hashToEmbedding(text: string): number[] {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    // Convert hash to fixed-size vector using multiple hash functions
    const embedding: number[] = [];
    for (let dim = 0; dim < DIMS; dim++) {
      // Combine text hash with dimension index for variation
      let val = 0;
      let h = hash;
      for (let j = 0; j < 3; j++) {
        h = ((h << 5) - h) + dim + j;
        h = h & h;
        val += Math.sin(h) * Math.cos(h * 2.1);
      }
      // Normalize to [-1, 1] then to [0, 1]
      embedding.push((Math.tanh(val) + 1) / 2);
    }
    
    // Normalize to unit vector
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    return embedding.map(v => v / magnitude);
  }

  isReady = true;

  return {
    get dims() { return DIMS; },
    get ready() { return isReady; },
    get providerName() { return "local-hash"; },

    async embed(text: string): Promise<number[]> {
      if (!isReady) {
        throw new Error("Embedding provider is not ready");
      }
      return hashToEmbedding(text);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      return texts.map(text => hashToEmbedding(text));
    },

    close(): void {
      isReady = false;
    },
  };
}

/**
 * Create an API-based embedding provider.
 */
async function createApiEmbeddingProvider(
  provider: string,
  apiKey: string,
): Promise<EmbeddingProvider> {
  const DIMS = provider === "openai" ? 1536 : 1024;
  let isReady = true;

  return {
    get dims() { return DIMS; },
    get ready() { return isReady; },
    get providerName() { return `api-${provider}`; },

    async embed(text: string): Promise<number[]> {
      if (!isReady) {
        throw new Error("Embedding provider is not ready");
      }

      if (provider === "openai") {
        const { default: openai } = await import("openai");
        const client = new openai({ apiKey });
        const response = await client.embeddings.create({
          model: "text-embedding-3-small",
          input: text,
        });
        return response.data[0].embedding;
      }

      throw new Error(`Unsupported API provider: ${provider}`);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      if (!isReady) {
        throw new Error("Embedding provider is not ready");
      }

      if (provider === "openai") {
        const { default: openai } = await import("openai");
        const client = new openai({ apiKey });
        const response = await client.embeddings.create({
          model: "text-embedding-3-small",
          input: texts,
        });
        return response.data.map(d => d.embedding);
      }

      throw new Error(`Unsupported API provider: ${provider}`);
    },

    close(): void {
      isReady = false;
    },
  };
}

/**
 * Download the nomic-embed-text-v1 model.
 *
 * @param modelsDir Directory to download the model to
 * @returns Path to the downloaded model
 */
export async function downloadEmbeddingModel(
  modelsDir: string,
): Promise<string> {
  const modelPath = path.join(modelsDir, "nomic-embed-text-v1.gguf");

  if (fs.existsSync(modelPath)) {
    console.log(`Model already exists at ${modelPath}`);
    return modelPath;
  }

  // Ensure directory exists
  fs.mkdirSync(modelsDir, { recursive: true });

  // Note: The GGUF format for nomic-embed-text-v1 may not be directly
  // compatible with node-llama-cpp. For local embeddings, consider:
  // 1. Using ONNX runtime with transformers.js
  // 2. Using a different embedding model that has GGUF support
  // 3. Using API-based embeddings
  
  console.log(`[Embedding] Model not found at ${modelPath}`);
  console.log(`[Embedding] For local embeddings, consider:`);
  console.log(`[Embedding]   - Using transformers.js with nomic-embed-text-v1.onnx`);
  console.log(`[Embedding]   - Using API-based embeddings (set type: "api" in config)`);
  console.log(`[Embedding]   - Using a GGUF-compatible embedding model`);

  throw new Error(
    "Embedding model not found. Either download manually or configure API-based embeddings.",
  );
}
