/**
 * Generate embeddings via Together API.
 */

const EMBEDDING_MODEL = "togethercomputer/m2-bert-80M-8k-retrieval";
const REQUEST_TIMEOUT_MS = 15000;

interface TogetherEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

function ensureNonEmpty(text: string): void {
  if (!text.trim()) {
    throw new Error("Embedding input is empty");
  }
}

async function requestEmbeddings(input: string | string[], apiKey: string): Promise<number[][]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.together.xyz/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as TogetherEmbeddingResponse;
    if (!data.data || data.data.length === 0) {
      throw new Error("Embedding API returned no data");
    }

    return data.data.map((item) => item.embedding);
  } catch (error) {
    const err = error as Error;
    if (err.name === "AbortError") {
      throw new Error("Embedding API request timed out");
    }

    if (err.message.startsWith("Embedding API error:")) {
      throw err;
    }

    throw new Error(`Embedding API request failed: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Generate an embedding for a single text.
 */
export async function embed(text: string, apiKey: string): Promise<number[]> {
  ensureNonEmpty(text);
  const embeddings = await requestEmbeddings(text, apiKey);
  return embeddings[0];
}

/**
 * Batch embed multiple texts in one call.
 */
export async function embedBatch(texts: string[], apiKey: string): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  for (const text of texts) {
    ensureNonEmpty(text);
  }

  return requestEmbeddings(texts, apiKey);
}
