import { computeRagPTrue } from "@/lib/ai/rag/ragPTrueProvider";
import { withOpenAiLimiter } from "@/lib/ai/openaiLimiter";
import { resolveEnsemblePTrue } from "@/lib/evPipeline/ensemblePTrue";
import { resolveMarketPrior } from "@/lib/evPipeline/pricing";
import {
  cachePTrue,
  evRedisKeys,
  getOrderBookMid,
} from "@/lib/evPipeline/redisCache";

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

/** Hard cap for live OpenAI ensemble on interactive / API paths. */
export const ENSEMBLE_LLM_TIMEOUT_MS = 5000;

const MEMORY_CACHE_TTL_MS = 15 * 60 * 1000;
const MEMORY_NEGATIVE_TTL_MS = 60 * 1000;

interface MemoryCacheEntry {
  result: EnsemblePricingResult;
  expiresAt: number;
}

const memoryHitCache = new Map<string, MemoryCacheEntry>();
const memoryNegativeUntil = new Map<string, number>();

export function isEnsembleLlmConfigured(): boolean {
  return !!(
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.AI_GATEWAY_API_KEY?.trim()
  );
}

function ensembleFallbackCacheKey(params: EnsemblePricingContext): string | null {
  const tokenId = params.tokenId?.trim().toLowerCase();
  if (tokenId) return `pm:${tokenId}`;
  const slug = params.slug?.trim().toLowerCase();
  if (slug) return `slug:${slug}`;
  const title = params.title?.trim().toLowerCase();
  if (title) return `title:${title.slice(0, 160)}`;
  return null;
}

function readMemoryCache(key: string): EnsemblePricingResult | null {
  const entry = memoryHitCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryHitCache.delete(key);
    return null;
  }
  return entry.result;
}

function writeMemoryCache(key: string, result: EnsemblePricingResult): void {
  memoryHitCache.set(key, {
    result,
    expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
  });
}

function isNegativeMemoryCached(key: string): boolean {
  const until = memoryNegativeUntil.get(key);
  if (!until) return false;
  if (Date.now() > until) {
    memoryNegativeUntil.delete(key);
    return false;
  }
  return true;
}

function markNegativeMemoryCache(key: string): void {
  memoryNegativeUntil.set(key, Date.now() + MEMORY_NEGATIVE_TTL_MS);
}

async function withHardTimeout<T>(
  ms: number | null | undefined,
  fn: () => Promise<T>
): Promise<T | null> {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    try {
      return await fn();
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, ms);

    fn()
      .then((value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
  });
}

async function persistEnsembleFallbackCache(
  tokenId: string,
  kalshiTicker: string | null,
  result: EnsemblePricingResult
): Promise<void> {
  try {
    await cachePTrue(tokenId, {
      pTrue: result.pTrue,
      variance: null,
      sourceScore: result.sourceScore,
      sourceType: result.source,
      kalshiTicker,
      calculatedAt: new Date().toISOString(),
    });
  } catch {
    // Non-fatal — memory cache still helps within the instance.
  }
}

/**
 * Resolve ensemble p_true from Redis/Postgres cache, then live OpenAI RAG ensemble.
 * Used when sportsbook consensus / PM-outcome mapping fails for any market category.
 */
export async function resolveEnsemblePTrueWithLlmFallback(
  params: EnsemblePricingContext,
  options?: {
    logPrefix?: string;
    /** `null` disables the cap (cron). Undefined uses {@link ENSEMBLE_LLM_TIMEOUT_MS}. */
    timeoutMs?: number | null;
  }
): Promise<EnsemblePricingResult | null> {
  const logPrefix = options?.logPrefix ?? "[ensemblePricingFallback]";
  const effectiveTimeout =
    options?.timeoutMs === undefined ? ENSEMBLE_LLM_TIMEOUT_MS : options.timeoutMs;
  const tokenId = params.tokenId?.trim().toLowerCase() || null;
  const kalshiTicker = params.kalshiTicker?.trim().toUpperCase() || null;
  const slug = params.slug?.trim() || null;
  const title = params.title?.trim() || null;
  const cacheKey = ensembleFallbackCacheKey(params);

  if (cacheKey) {
    const memoryHit = readMemoryCache(cacheKey);
    if (memoryHit) {
      return memoryHit;
    }
    if (isNegativeMemoryCached(cacheKey)) {
      return null;
    }
  }

  let ensemblePTrue: number | null = tokenId
    ? await resolveEnsemblePTrue(tokenId)
    : null;

  if (ensemblePTrue != null) {
    console.log(`${logPrefix} cached ensemble p_true`, {
      tokenId,
      ensemblePTrue,
    });
    const cached: EnsemblePricingResult = {
      pTrue: ensemblePTrue,
      source: "cached_ensemble",
      sourceScore: 0.75,
    };
    if (cacheKey) writeMemoryCache(cacheKey, cached);
    return cached;
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

  const computed = await withHardTimeout(effectiveTimeout, () =>
    withOpenAiLimiter(() =>
      computeRagPTrue({
        tokenId,
        kalshiTicker,
        title: title ?? tokenId ?? slug ?? "Unknown market",
        slug,
        pmMid,
        kalshiMid: params.kalshiMid ?? null,
        exchangeMid: params.exchangeMid ?? null,
        marketPrior,
      })
    )
  );

  if (!computed) {
    if (cacheKey) markNegativeMemoryCache(cacheKey);
    console.warn(`${logPrefix} OpenAI ensemble fallback timed out or failed`, {
      tokenId,
      slug,
      title,
      timeoutMs: effectiveTimeout,
    });
    return null;
  }

  console.log(`${logPrefix} OpenAI ensemble p_true`, {
    tokenId,
    slug,
    title,
    ensemblePTrue: computed.engine.pTrue,
    sourceScore: computed.engine.sourceScore,
    usedFallback: computed.engine.usedFallback,
  });

  const result: EnsemblePricingResult = {
    pTrue: computed.engine.pTrue,
    source: "rag_ensemble",
    sourceScore: computed.engine.sourceScore,
    contextIds: computed.contextIds,
    usedFallback: computed.engine.usedFallback,
  };

  if (tokenId) {
    await persistEnsembleFallbackCache(tokenId, kalshiTicker, result);
  }
  if (cacheKey) writeMemoryCache(cacheKey, result);

  return result;
}
