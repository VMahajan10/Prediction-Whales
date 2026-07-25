import { computeRagPTrue } from "@/lib/ai/rag/ragPTrueProvider";
import { resolveEnsemblePTrue } from "@/lib/evPipeline/ensemblePTrue";
import { resolveMarketPrior } from "@/lib/evPipeline/pricing";
import { evRedisKeys, getOrderBookMid } from "@/lib/evPipeline/redisCache";

export interface EnsemblePricingContext {
  tokenId?: string | null;
  kalshiTicker?: string | null;
  title?: string | null;
  slug?: string | null;
  pmMid?: number | null;
  kalshiMid?: number | null;
  exchangeMid?: number | null;
}

export interface EnsemblePricingResult {
  pTrue: number;
  source: "cached_ensemble" | "rag_ensemble";
  sourceScore: number;
  contextIds?: string[];
  usedFallback?: boolean;
}

export function isEnsembleLlmConfigured(): boolean {
  return !!(
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.AI_GATEWAY_API_KEY?.trim()
  );
}

/**
 * Resolve ensemble p_true from Redis/Postgres cache, then live OpenAI RAG ensemble.
 * Used when sportsbook consensus / PM-outcome mapping fails for any market category.
 */
export async function resolveEnsemblePTrueWithLlmFallback(
  params: EnsemblePricingContext,
  options?: { logPrefix?: string }
): Promise<EnsemblePricingResult | null> {
  const logPrefix = options?.logPrefix ?? "[ensemblePricingFallback]";
  const tokenId = params.tokenId?.trim().toLowerCase() || null;
  const kalshiTicker = params.kalshiTicker?.trim().toUpperCase() || null;
  const slug = params.slug?.trim() || null;
  const title = params.title?.trim() || null;

  let ensemblePTrue: number | null = tokenId
    ? await resolveEnsemblePTrue(tokenId)
    : null;

  if (ensemblePTrue != null) {
    console.log(`${logPrefix} cached ensemble p_true`, {
      tokenId,
      ensemblePTrue,
    });
    return {
      pTrue: ensemblePTrue,
      source: "cached_ensemble",
      sourceScore: 0.75,
    };
  }

  if (!isEnsembleLlmConfigured()) {
    console.warn(
      `${logPrefix} OPENAI_API_KEY missing — ensemble fallback unavailable`
    );
    return null;
  }

  if (!title && !tokenId && !slug) {
    return null;
  }

  let pmMid = params.pmMid ?? null;
  if (pmMid == null && tokenId) {
    try {
      const ob = await getOrderBookMid(evRedisKeys.orderBookPm(tokenId));
      pmMid = ob?.mid ?? null;
    } catch {
      // Fall through with neutral prior.
    }
  }

  const marketPrior = resolveMarketPrior(
    pmMid,
    params.kalshiMid ?? null,
    null
  );

  try {
    const computed = await computeRagPTrue({
      tokenId,
      kalshiTicker,
      title: title ?? tokenId ?? slug ?? "Unknown market",
      slug,
      pmMid,
      kalshiMid: params.kalshiMid ?? null,
      exchangeMid: params.exchangeMid ?? null,
      marketPrior,
    });

    console.log(`${logPrefix} OpenAI ensemble p_true`, {
      tokenId,
      slug,
      title,
      ensemblePTrue: computed.engine.pTrue,
      sourceScore: computed.engine.sourceScore,
      usedFallback: computed.engine.usedFallback,
    });

    return {
      pTrue: computed.engine.pTrue,
      source: "rag_ensemble",
      sourceScore: computed.engine.sourceScore,
      contextIds: computed.contextIds,
      usedFallback: computed.engine.usedFallback,
    };
  } catch (error) {
    console.warn(`${logPrefix} OpenAI ensemble fallback failed`, {
      tokenId,
      slug,
      title,
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}
