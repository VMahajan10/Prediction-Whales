import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  type MappingFailure,
} from "@/lib/evPipeline/types";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const BATCH_SIZE = 64;
const INTER_BATCH_DELAY_MS = 250;

export interface EmbeddingBatchResult {
  vectors: number[][];
  failures: MappingFailure[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOpenAiConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}

/** Cosine similarity for L2-normalized embedding vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function embedBatchWithRetry(
  inputs: string[],
  maxAttempts = 4
): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: inputs,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "2");
        const delayMs = Math.min(60_000, Math.max(1000, retryAfter * 1000));
        console.warn(
          `[ev/map-markets] OpenAI rate limited; retry in ${delayMs}ms (batch size ${inputs.length})`
        );
        await sleep(delayMs);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OpenAI embeddings HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };

      const rows = data.data ?? [];
      if (rows.length !== inputs.length) {
        throw new Error(
          `OpenAI returned ${rows.length} embeddings for ${inputs.length} inputs`
        );
      }

      return rows
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((row) => {
          const vec = row.embedding;
          if (!vec || vec.length !== EMBEDDING_DIMENSIONS) {
            throw new Error("Invalid embedding vector returned");
          }
          return vec;
        });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const delayMs = 500 * 2 ** attempt;
      console.warn(
        `[ev/map-markets] OpenAI embed attempt ${attempt + 1} failed: ${lastError.message}`
      );
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("OpenAI embedding batch failed");
}

export async function embedTexts(texts: string[]): Promise<EmbeddingBatchResult> {
  const failures: MappingFailure[] = [];

  if (!isOpenAiConfigured()) {
    const message =
      "OPENAI_API_KEY is not configured — set it in .env.local to enable text-embedding-3-small matching";
    console.error("[ev/map-markets]", message);
    failures.push({
      stage: "embed",
      message,
    });
    return { vectors: [], failures };
  }

  if (texts.length === 0) {
    return { vectors: [], failures };
  }

  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => t || " ");
    try {
      const batchVectors = await embedBatchWithRetry(batch);
      vectors.push(...batchVectors);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Embedding batch failed";
      failures.push({ stage: "embed", message: `Batch ${i / BATCH_SIZE + 1}: ${message}` });
      console.error("[ev/map-markets] Embedding batch failure:", message);
      return { vectors: [], failures };
    }

    if (i + BATCH_SIZE < texts.length) {
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }

  return { vectors, failures };
}

export function isEmbeddingConfigured(): boolean {
  return isOpenAiConfigured();
}
