import { isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { isEmbeddingConfigured } from "@/lib/evPipeline/embeddings";

export interface MatchMarketsPreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface MatchMarketsPreflightOptions {
  persist?: boolean;
}

/**
 * Validates env + service prerequisites before embedding / persistence.
 */
export function validateMatchMarketsPreflight(
  options: MatchMarketsPreflightOptions = {}
): MatchMarketsPreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const persist = options.persist !== false;

  if (!isEmbeddingConfigured()) {
    errors.push(
      "OPENAI_API_KEY is not set — required for OpenAI text-embedding-3-small vector matching"
    );
  }

  if (persist && !isDatabaseEnabled()) {
    errors.push(
      "DATABASE_URL is not set — required to upsert market_mappings during persist"
    );
  }

  if (
    !process.env.UPSTASH_REDIS_REST_URL?.trim() ||
    !process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  ) {
    warnings.push(
      "UPSTASH_REDIS_REST_URL/TOKEN not set — mapping cache writes will be skipped"
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function formatPreflightErrors(
  preflight: MatchMarketsPreflightResult
): string {
  return preflight.errors.join("; ");
}
