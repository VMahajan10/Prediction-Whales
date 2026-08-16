import { eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { marketMappings } from "@/lib/crossmarket/store/schema";
import type { EvPlatform } from "@/lib/finance/evEngine";
import {
  enrichPipelineEvInputFromMapping,
  normalizeKalshiTicker,
  normalizePmTokenId,
  pipelineMappingPairKey,
} from "@/lib/evPipeline/crossAssetLookup";
import {
  applyExecutionPricingToTradeEv,
  buildPipelineTradeEvFromPricing,
  resolveMarketPrior,
} from "@/lib/evPipeline/pricing";
import { buildPipelineTradeEvFromPTrue } from "@/lib/evPipeline/computeTradeEv";
import {
  canResolvePTrueAsset,
  resolvePTrue,
} from "@/lib/evPipeline/pTrueEnsembleResolver";
import {
  pickAuthoritativeEnsemblePTrue,
  resolveEnsemblePTrue,
  resolveEnsemblePTrueLookup,
} from "@/lib/evPipeline/ensemblePTrue";
import {
  fetchKalshiMarketOrderBookMid,
  fetchPolymarketClobOrderBookMid,
} from "@/lib/evPipeline/orderBookIngest";
import { lookupExchangeConsensusBaseline } from "@/lib/evPipeline/exchangeConsensusArb";
import {
  cacheTradeEvLookup,
  evRedisKeys,
  EvPipelineRedisWriteBatch,
  getMappingByKalshi,
  getMappingByPm,
  getOrderBookMid,
  getTradeEvLookup,
  getTradeEvLookupRedisOnly,
  readLocalTradeEvLookup,
  type CachedMapping,
} from "@/lib/evPipeline/redisCache";
import { computeEvForMappedPair } from "@/lib/evPipeline/computeMappedEv";
import {
  deriveEvPercentFromPTrue,
  coalesceDisplayEvPercent,
  DEFAULT_P_MARKET_FALLBACK,
  normalizeIncomingTradePrice,
  normalizePipelineTradeEv,
  pipelineEvTone,
  strictApiTradeEvPayload,
} from "@/lib/evPipeline/tradeEvRecord";
import type {
  PipelineTradeEv,
  PipelineTradeEvInput,
} from "@/lib/evPipeline/types";
import { pipelineEvLookupKey } from "@/lib/evPipeline/types";

export type { PipelineTradeEv, PipelineTradeEvInput };

function tradeEvKey(input: PipelineTradeEvInput): string | null {
  return pipelineEvLookupKey(input);
}

function finalizePipelineTradeEv(
  record: PipelineTradeEv,
  lookupKey: string
): PipelineTradeEv {
  return normalizePipelineTradeEv(record, lookupKey) ?? record;
}

export function createUnmappedPipelineTradeEv(
  key: string,
  input?: PipelineTradeEvInput
): PipelineTradeEv {
  return {
    key,
    status: "unmapped",
    tokenId: normalizePmTokenId(input?.tokenId) ?? null,
    kalshiTicker: normalizeKalshiTicker(input?.kalshiTicker) ?? null,
    mappingPairKey: null,
    netEvPercent: null,
    netEv: 0,
    grossEv: 0,
    grossEvPercent: null,
    averageEv: null,
    pTrue: null,
    pMarket: null,
    pmMid: null,
    kalshiMid: null,
    pTrueSource: null,
    pTrueConfidence: null,
    pTrueLowConfidence: false,
    evFormulaVersion: null,
  };
}

/** Soft failure when remote EV resolution times out — never throws upstream. */
export function createTimeoutPipelineTradeEv(
  key: string,
  input?: PipelineTradeEvInput
): PipelineTradeEv {
  return {
    ...createUnmappedPipelineTradeEv(key, input),
    status: "timeout",
  };
}

/** Always returns status ok with numeric pTrue/EV when asset identity exists. */
export async function createLowConfidencePipelineTradeEv(
  key: string,
  item: PipelineTradeEvInput,
  mapping?: CachedMapping | null,
  ensembleLlmTimeoutMs?: number | null
): Promise<PipelineTradeEv> {
  const tokenId = normalizePmTokenId(item.tokenId);
  const kalshiTicker = normalizeKalshiTicker(item.kalshiTicker);
  const platform: EvPlatform =
    item.source === "kalshi" ? "kalshi" : "polymarket";
  const mappingPairKey =
    tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : null;

  const books = await loadOrderBookContext(tokenId, kalshiTicker);
  const exchangeMid = await resolveSportsExchangeMid(
    item,
    tokenId,
    mappingPairKey,
    books,
    ensembleLlmTimeoutMs
  );

  const pTrueResult = await resolvePTrue({
    mappingPairKey,
    platform,
    tokenId,
    kalshiTicker,
    title: item.title,
    slug: item.slug,
    pmOb: books.pmOb,
    kalshiOb: books.kalshiOb,
    pmMid: books.pmMid,
    kalshiMid: books.kalshiMid,
    exchangeMid,
    executionPrice: item.tradePrice,
    ensemblePTrue: authoritativeMappingEnsemblePTrue(mapping),
    fetchEnsemble: true,
    fetchExchangeConsensus: platform === "polymarket" && exchangeMid == null,
    computeEnsembleIfMissing: true,
    computeRagIfMissing: true,
    ensembleLlmTimeoutMs,
  });

  return attachAverageEvField(
    buildPipelineTradeEvFromPTrue(key, pTrueResult, {
      platform,
      tokenId,
      kalshiTicker,
      mappingPairKey,
      executionPrice: item.tradePrice,
    })
  );
}

const STALE_FALLBACK_PROB_EPS = 1e-6;

export interface IsFullyComputedTradeEvContext {
  executionPrice?: number | null;
}

function resolvedExecutionPrice(
  raw: number | null | undefined
): number | null {
  if (raw == null) return null;
  return normalizeIncomingTradePrice(raw) ?? null;
}

function isZeroEvPercent(value: number | null | undefined): boolean {
  if (value == null || !Number.isFinite(value)) return false;
  return Object.is(value, -0) || value === 0;
}

/** Hard-default payloads where fair value collapsed to the market mid without book data. */
export function isStaleFallbackZeroPayload(
  payload: PipelineTradeEv
): boolean {
  const netEv = payload.netEvPercent ?? payload.averageEv ?? null;
  if (!isZeroEvPercent(netEv)) return false;

  const lacksBookMids = payload.pmMid == null && payload.kalshiMid == null;
  const pTrue = payload.pTrue;
  const pMarket = payload.pMarket;
  const collapsedFairValue =
    pTrue != null &&
    pMarket != null &&
    Number.isFinite(pTrue) &&
    Number.isFinite(pMarket) &&
    Math.abs(pTrue - pMarket) <= STALE_FALLBACK_PROB_EPS;

  return lacksBookMids || collapsedFairValue;
}

/**
 * Zero-EV cache rows without execution context should be repriced — mirrors
 * resolvePipelineTradeEv's cached-zero rejection.
 */
export function shouldBypassStaleEvCacheHit(
  payload: PipelineTradeEv | null | undefined,
  context: IsFullyComputedTradeEvContext = {}
): boolean {
  if (!payload || payload.status !== "ok") return false;

  const netEv = payload.netEvPercent ?? payload.averageEv ?? null;
  if (!isZeroEvPercent(netEv)) return false;

  if (resolvedExecutionPrice(context.executionPrice) != null) return false;

  return true;
}

export function isFullyComputedTradeEv(
  payload: PipelineTradeEv | null | undefined,
  context: IsFullyComputedTradeEvContext = {}
): payload is PipelineTradeEv & {
  status: "ok";
  netEvPercent: number;
  grossEvPercent: number;
  averageEv: number;
  pTrue: number;
} {
  if (
    payload == null ||
    payload.status !== "ok" ||
    payload.netEvPercent == null ||
    !Number.isFinite(payload.netEvPercent) ||
    payload.pTrue == null ||
    !Number.isFinite(payload.pTrue)
  ) {
    return false;
  }

  const netEv = payload.netEvPercent ?? payload.averageEv ?? null;
  if (!isZeroEvPercent(netEv)) return true;

  const executionPrice = resolvedExecutionPrice(context.executionPrice);
  if (executionPrice != null) return true;

  if (isStaleFallbackZeroPayload(payload)) return false;

  // Align with resolvePipelineTradeEv — reject cached 0% when not trade-anchored.
  return false;
}

export function attachAverageEvField(
  payload: PipelineTradeEv
): PipelineTradeEv {
  if (payload.status !== "ok") return payload;
  const displayEv = coalesceDisplayEvPercent(payload);
  const grossEvPercent =
    payload.grossEvPercent ??
    payload.netEvPercent ??
    displayEv;
  return {
    ...payload,
    averageEv: displayEv,
    grossEvPercent,
    grossEv: payload.grossEv ?? payload.netEv ?? 0,
    netEvPercent: payload.netEvPercent ?? displayEv,
  };
}

export function buildTradeEvFromCachedMapping(
  lookupKey: string,
  mapping: CachedMapping,
  item: PipelineTradeEvInput
): PipelineTradeEv | null {
  const netEvPercent =
    mapping.netEvPercent ?? mapping.grossEvPercent ?? mapping.averageEv;
  if (netEvPercent == null || !Number.isFinite(netEvPercent)) return null;

  const pTrue = pickAuthoritativeEnsemblePTrue(mapping.pTrue);
  if (pTrue == null) return null;

  const tokenId = normalizePmTokenId(item.tokenId ?? mapping.polymarketTokenId);
  const kalshiTicker = normalizeKalshiTicker(
    item.kalshiTicker ?? mapping.kalshiTicker
  );

  return attachAverageEvField({
    key: lookupKey,
    status: "ok",
    tokenId,
    kalshiTicker,
    mappingPairKey:
      tokenId && kalshiTicker
        ? pipelineMappingPairKey(tokenId, kalshiTicker)
        : null,
    pTrue: mapping.pTrue,
    pMarket: null,
    netEvPercent,
    grossEvPercent: mapping.grossEvPercent ?? netEvPercent,
    averageEv: netEvPercent ?? mapping.averageEv,
    netEv: 0,
    pmMid: null,
    kalshiMid: null,
  });
}

/** Redis first, then Postgres market_mappings when the mapping cache is cold. */
export async function loadMappingForTradeEv(
  tokenId?: string | null,
  kalshiTicker?: string | null
): Promise<CachedMapping | null> {
  const pm = normalizePmTokenId(tokenId);
  const kalshi = normalizeKalshiTicker(kalshiTicker);

  if (pm) {
    const fromRedis = await getMappingByPm(pm);
    if (fromRedis) return fromRedis;
  }

  if (kalshi) {
    const fromRedis = await getMappingByKalshi(kalshi);
    if (fromRedis) return fromRedis;
  }

  if (!isDatabaseEnabled()) return null;

  try {
    const db = getDb();
    if (pm) {
      const rows = await db
        .select({
          polymarketTokenId: marketMappings.polymarketTokenId,
          kalshiTicker: marketMappings.kalshiTicker,
          confidenceScore: marketMappings.confidenceScore,
          orientation: marketMappings.orientation,
          matchMethod: marketMappings.matchMethod,
        })
        .from(marketMappings)
        .where(eq(marketMappings.polymarketTokenId, pm))
        .limit(1);
      const row = rows[0];
      if (row) {
        return {
          polymarketTokenId: row.polymarketTokenId.toLowerCase(),
          kalshiTicker: row.kalshiTicker.toUpperCase(),
          confidenceScore: row.confidenceScore,
          orientation: row.orientation as CachedMapping["orientation"],
          matchMethod: row.matchMethod,
        };
      }
    }

    if (kalshi) {
      const rows = await db
        .select({
          polymarketTokenId: marketMappings.polymarketTokenId,
          kalshiTicker: marketMappings.kalshiTicker,
          confidenceScore: marketMappings.confidenceScore,
          orientation: marketMappings.orientation,
          matchMethod: marketMappings.matchMethod,
        })
        .from(marketMappings)
        .where(eq(marketMappings.kalshiTicker, kalshi))
        .limit(1);
      const row = rows[0];
      if (row) {
        return {
          polymarketTokenId: row.polymarketTokenId.toLowerCase(),
          kalshiTicker: row.kalshiTicker.toUpperCase(),
          confidenceScore: row.confidenceScore,
          orientation: row.orientation as CachedMapping["orientation"],
          matchMethod: row.matchMethod,
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

function authoritativeMappingEnsemblePTrue(
  mapping?: CachedMapping | null
): number | null {
  if (mapping?.pTrue == null || !Number.isFinite(mapping.pTrue)) return null;
  return pickAuthoritativeEnsemblePTrue(mapping.pTrue);
}

async function loadEnsemblePricingContext(
  tokenId: string | null,
  books: OrderBookContext,
  mapping?: CachedMapping | null
): Promise<{ ensemblePTrue: number | null; marketPrior: number }> {
  const mappingEnsemble = authoritativeMappingEnsemblePTrue(mapping);
  const ensemblePTrue =
    mappingEnsemble ?? (tokenId ? await resolveEnsemblePTrue(tokenId) : null);
  const marketPrior = resolveMarketPrior(
    books.pmMid,
    books.kalshiMid,
    null
  );
  return { ensemblePTrue, marketPrior };
}

/** Standalone / cache-miss pricing using resting order-book baseline + execution price. */
export function buildDynamicBaselineTradeEv(
  searchKey: string,
  item?: PipelineTradeEvInput
): PipelineTradeEv {
  const lower = searchKey.toLowerCase();
  const executionPrice = normalizeIncomingTradePrice(item?.tradePrice);

  let tokenId: string | null = normalizePmTokenId(item?.tokenId);
  let kalshiTicker: string | null = normalizeKalshiTicker(item?.kalshiTicker);
  let platform: EvPlatform =
    item?.source === "kalshi" ? "kalshi" : "polymarket";

  if (lower.startsWith("pm:")) {
    tokenId = normalizePmTokenId(searchKey.slice(3));
    platform = "polymarket";
  } else if (lower.startsWith("kalshi:")) {
    kalshiTicker = normalizeKalshiTicker(searchKey.slice(7));
    platform = "kalshi";
  }

  const priced = buildPipelineTradeEvFromPricing({
    lookupKey: searchKey,
    platform,
    tokenId,
    kalshiTicker,
    mappingPairKey: null,
    executionPrice,
    pmMid: executionPrice ?? DEFAULT_P_MARKET_FALLBACK,
    kalshiMid: executionPrice ?? DEFAULT_P_MARKET_FALLBACK,
  });

  return attachAverageEvField(priced);
}

async function syncComputePricingEv(
  lookupKey: string,
  item: PipelineTradeEvInput,
  mapping?: CachedMapping | null,
  ensembleLlmTimeoutMs?: number | null
): Promise<PipelineTradeEv | null> {
  const enriched = mapping
    ? enrichPipelineEvInputFromMapping(item, mapping)
    : await enrichInputFromMappingCache(item);

  const result = await resolveTradeEvViaEnsemblePricing(
    lookupKey,
    enriched,
    mapping,
    ensembleLlmTimeoutMs
  );
  if (!result) return null;

  await cacheTradeEvLookup(lookupKey, result);
  return result;
}

async function syncComputePipelineEvForMapping(
  lookupKey: string,
  item: PipelineTradeEvInput,
  mapping: CachedMapping
): Promise<PipelineTradeEv | null> {
  if (!isDatabaseEnabled()) return null;

  try {
    const tokenId = normalizePmTokenId(
      item.tokenId ?? mapping.polymarketTokenId
    );
    const kalshiTicker = normalizeKalshiTicker(
      item.kalshiTicker ?? mapping.kalshiTicker
    );
    if (!tokenId || !kalshiTicker) return null;

    const books = await loadOrderBookContext(tokenId, kalshiTicker);
    const redisBatch = new EvPipelineRedisWriteBatch();
    const db = getDb();

    const snapshot = await computeEvForMappedPair(
      db,
      {
        polymarketTokenId: tokenId,
        kalshiTicker,
        polymarketTitle: tokenId,
        kalshiTitle: kalshiTicker,
        pmMid: books.pmMid,
        kalshiMid: books.kalshiMid,
        pmOb: books.pmOb,
        kalshiOb: books.kalshiOb,
      },
      redisBatch
    );

    await redisBatch.flush();

    if (!snapshot) return null;

    const fromMapping = buildTradeEvFromCachedMapping(lookupKey, {
      ...mapping,
      pTrue: snapshot.pTrue,
      averageEv: snapshot.averageEv,
      grossEvPercent: snapshot.grossEvPercent,
      netEvPercent: snapshot.netEvPercent,
      evComputedAt: snapshot.computedAt,
    }, item);

    if (fromMapping) {
      await cacheTradeEvLookup(lookupKey, fromMapping);
      return fromMapping;
    }

    return readLocalTradeEvLookup(lookupKey, item.source);
  } catch (err) {
    console.error(
      "[ev/trades] sync pipeline EV failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function finalizeApiTradeEv(
  record: PipelineTradeEv,
  lookupKey: string,
  item: PipelineTradeEvInput
): PipelineTradeEv {
  const normalized = normalizePipelineTradeEv(record, lookupKey) ?? record;
  let payload = attachAverageEvField(
    strictApiTradeEvPayload(normalized, lookupKey)
  );

  const executionPrice = normalizeIncomingTradePrice(item.tradePrice);
  if (executionPrice != null && payload.status === "ok") {
    payload = attachAverageEvField(
      applyExecutionPricingToTradeEv(payload, {
        lookupKey,
        platform: item.source,
        executionPrice,
        tokenId: payload.tokenId,
        kalshiTicker: payload.kalshiTicker,
        mappingPairKey: payload.mappingPairKey ?? null,
        pmMid: payload.pmMid ?? null,
        kalshiMid: payload.kalshiMid ?? null,
        ensemblePTrue: payload.pTrue,
        baselinePTrue: payload.pTrue,
        marketPrior: resolveMarketPrior(
          payload.pmMid ?? null,
          payload.kalshiMid ?? null
        ),
      })
    );
  }

  return payload;
}

/**
 * Trade EV from the persisted `true_probabilities` ensemble row — no LLM, one
 * indexed read. Survives the 90s Redis p_true TTL, so cache-only callers can
 * still price assets the pipeline has already scored.
 */
async function buildPersistedEnsembleTradeEv(
  lookupKey: string,
  item: PipelineTradeEvInput
): Promise<PipelineTradeEv | null> {
  let tokenId = normalizePmTokenId(item.tokenId);
  if (!tokenId) {
    const kalshiTicker = normalizeKalshiTicker(item.kalshiTicker);
    if (kalshiTicker) {
      const mapping = await loadMappingForTradeEv(null, kalshiTicker);
      tokenId = normalizePmTokenId(mapping?.polymarketTokenId);
    }
  }
  if (!tokenId) return null;

  const executionPrice = normalizeIncomingTradePrice(item.tradePrice);
  if (executionPrice == null) return null;

  const lookup = await resolveEnsemblePTrueLookup(tokenId);
  if (!lookup) return null;

  return {
    key: lookupKey,
    status: "ok",
    tokenId,
    kalshiTicker: normalizeKalshiTicker(item.kalshiTicker),
    mappingPairKey: null,
    netEvPercent: null,
    netEv: 0,
    grossEv: 0,
    grossEvPercent: null,
    averageEv: null,
    pTrue: lookup.pTrue,
    pMarket: executionPrice,
    pmMid: null,
    kalshiMid: null,
    pTrueSource: "cached_ensemble",
    pTrueConfidence: lookup.sourceScore,
    pTrueLowConfidence: false,
  };
}

export interface EnsureTradeEvOptions {
  /**
   * Read cached EV only. Skips mapping lookups, sync pricing and p_true
   * computation so request paths that cannot afford LLM latency stay fast.
   */
  cacheOnly?: boolean;
  /** Hard cap on live OpenAI ensemble (ms). Defaults to 2.5s when unset. */
  ensembleLlmTimeoutMs?: number | null;
}

/**
 * Resolve trade EV for API responses — always returns numeric EV for mapped markets.
 * Reads precomputed pipeline cache first; sync-computes before responding on cache miss.
 */
export async function ensureFullyComputedTradeEv(
  lookupKey: string,
  item: PipelineTradeEvInput,
  mapping?: CachedMapping | null,
  options?: EnsureTradeEvOptions
): Promise<PipelineTradeEv> {
  const cacheOnly = options?.cacheOnly === true;
  const ensembleLlmTimeoutMs = options?.ensembleLlmTimeoutMs;
  const resolvedMapping =
    mapping ??
    (cacheOnly
      ? null
      : await loadMappingForTradeEv(item.tokenId, item.kalshiTicker));

  const executionPrice = resolvedExecutionPrice(item.tradePrice);
  const finalizeContext: IsFullyComputedTradeEvContext = { executionPrice };

  const tryFinalize = (record: PipelineTradeEv | null | undefined) => {
    if (!record) return null;
    const payload = finalizeApiTradeEv(record, lookupKey, item);
    return isFullyComputedTradeEv(payload, finalizeContext) ? payload : null;
  };

  const tryAcceptCacheHit = (
    record: PipelineTradeEv | null | undefined
  ): PipelineTradeEv | null => {
    const finalized = tryFinalize(record);
    if (!finalized) return null;
    if (shouldBypassStaleEvCacheHit(finalized, finalizeContext)) {
      return null;
    }
    return finalized;
  };

  const localHit = tryAcceptCacheHit(
    readLocalTradeEvLookup(lookupKey, item.source)
  );
  if (localHit) return localHit;

  const storeHit = tryAcceptCacheHit(await getTradeEvLookup(lookupKey));
  if (storeHit) {
    if (cacheOnly) return storeHit;
    await cacheTradeEvLookup(lookupKey, storeHit);
    return storeHit;
  }

  if (resolvedMapping) {
    const fromMapping = tryFinalize(
      buildTradeEvFromCachedMapping(lookupKey, resolvedMapping, item)
    );
    if (fromMapping) {
      await cacheTradeEvLookup(lookupKey, fromMapping);
      return fromMapping;
    }
  }

  if (cacheOnly) {
    const persisted = tryFinalize(
      await buildPersistedEnsembleTradeEv(lookupKey, item)
    );
    if (persisted) {
      await cacheTradeEvLookup(lookupKey, persisted);
      return persisted;
    }
    const books = await loadOrderBookContext(
      normalizePmTokenId(item.tokenId),
      normalizeKalshiTicker(item.kalshiTicker),
      { liveFallback: false }
    );
    return {
      ...createUnmappedPipelineTradeEv(lookupKey, item),
      pmMid: books.pmMid,
      kalshiMid: books.kalshiMid,
      pMarket: books.pmMid ?? books.kalshiMid ?? null,
    };
  }

  const syncPriced = tryFinalize(
    await syncComputePricingEv(
      lookupKey,
      item,
      resolvedMapping,
      ensembleLlmTimeoutMs
    )
  );
  if (syncPriced) return syncPriced;

  try {
    const resolved = await resolvePipelineTradeEv(item, ensembleLlmTimeoutMs);
    const resolvedPayload = tryFinalize(resolved);
    if (resolvedPayload) return resolvedPayload;
  } catch (resolveErr) {
    console.error(
      "[ev/trades] resolvePipelineTradeEv failed:",
      resolveErr instanceof Error ? resolveErr.message : resolveErr
    );
  }

  if (resolvedMapping) {
    const pipelineSynced = tryFinalize(
      await syncComputePipelineEvForMapping(lookupKey, item, resolvedMapping)
    );
    if (pipelineSynced) return pipelineSynced;

    const retryLocal = tryAcceptCacheHit(
      readLocalTradeEvLookup(lookupKey, item.source)
    );
    if (retryLocal) return retryLocal;

    const retryStore = tryAcceptCacheHit(await getTradeEvLookup(lookupKey));
    if (retryStore) return retryStore;
  }

  if (resolvedMapping) {
    console.warn(
      `[ev/trades] Mapped market ${lookupKey} missing precomputed EV after sync attempts`
    );
  }

  if (canResolvePTrueAsset(item)) {
    const lowConfidence = await createLowConfidencePipelineTradeEv(
      lookupKey,
      item,
      resolvedMapping,
      ensembleLlmTimeoutMs
    );
    const finalized = tryFinalize(lowConfidence);
    if (finalized) {
      await cacheTradeEvLookup(lookupKey, finalized);
      return finalized;
    }
    await cacheTradeEvLookup(lookupKey, lowConfidence);
    return lowConfidence;
  }

  if (item.source === "kalshi") {
    const kalshiFallback = await buildKalshiTradeEvFallback(
      lookupKey,
      item,
      resolvedMapping
    );
    const finalizedKalshi = tryFinalize(kalshiFallback);
    if (finalizedKalshi) {
      await cacheTradeEvLookup(lookupKey, finalizedKalshi);
      return finalizedKalshi;
    }
  }

  return createUnmappedPipelineTradeEv(lookupKey, item);
}

async function resolvePmTokenForKalshi(
  kalshiTicker: string
): Promise<string | null> {
  try {
    const mapped = await getMappingByKalshi(kalshiTicker);
    if (mapped?.polymarketTokenId) {
      return mapped.polymarketTokenId.toLowerCase();
    }

    if (!isDatabaseEnabled()) return null;

    const db = getDb();
    const rows = await db
      .select({ polymarketTokenId: marketMappings.polymarketTokenId })
      .from(marketMappings)
      .where(eq(marketMappings.kalshiTicker, kalshiTicker.toUpperCase()))
      .limit(1);
    return rows[0]?.polymarketTokenId?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * Kalshi-only EV fallback when ensemble / sportsbook paths abstain:
 * 1) cross-venue — PM mid as fair value vs Kalshi execution price
 * 2) standalone — Kalshi mid as fair value (0% EV at market)
 */
async function buildKalshiTradeEvFallback(
  lookupKey: string,
  item: PipelineTradeEvInput,
  mapping?: CachedMapping | null
): Promise<PipelineTradeEv | null> {
  if (item.source !== "kalshi") return null;

  const kalshiTicker = normalizeKalshiTicker(item.kalshiTicker);
  if (!kalshiTicker) return null;

  const tokenId = normalizePmTokenId(
    item.tokenId ??
      mapping?.polymarketTokenId ??
      (await resolvePmTokenForKalshi(kalshiTicker))
  );
  const books = await loadOrderBookContext(tokenId, kalshiTicker);
  const executionPrice = normalizeIncomingTradePrice(item.tradePrice);
  const mappingPairKey =
    tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : null;

  if (executionPrice != null) {
    const pTrueResult = await resolvePTrue({
      mappingPairKey,
      platform: "kalshi",
      tokenId,
      kalshiTicker,
      title: item.title,
      slug: item.slug,
      pmOb: books.pmOb,
      kalshiOb: books.kalshiOb,
      pmMid: books.pmMid,
      kalshiMid: books.kalshiMid,
      executionPrice,
      ensemblePTrue: authoritativeMappingEnsemblePTrue(mapping),
      fetchEnsemble: true,
      fetchExchangeConsensus: true,
      computeEnsembleIfMissing: false,
      computeRagIfMissing: false,
    });

    const fromPTrue = attachAverageEvField(
      finalizePipelineTradeEv(
        buildPipelineTradeEvFromPTrue(lookupKey, pTrueResult, {
          platform: "kalshi",
          tokenId,
          kalshiTicker,
          mappingPairKey,
          executionPrice,
        }),
        lookupKey
      )
    );
    if (
      fromPTrue.status === "ok" &&
      fromPTrue.netEvPercent != null &&
      Number.isFinite(fromPTrue.netEvPercent)
    ) {
      return fromPTrue;
    }
  }

  if (
    tokenId &&
    books.pmMid != null &&
    Number.isFinite(books.pmMid) &&
    executionPrice != null &&
    executionPrice > 0
  ) {
    const pTrue = books.pmMid;
    const netEvPercent =
      ((pTrue - executionPrice) / executionPrice) * 100;
    if (netEvPercent != null && Number.isFinite(netEvPercent)) {
      return attachAverageEvField({
        key: lookupKey,
        status: "ok",
        tokenId,
        kalshiTicker,
        mappingPairKey,
        pTrue,
        pMarket: executionPrice,
        pmMid: books.pmMid,
        kalshiMid: books.kalshiMid,
        netEvPercent,
        grossEvPercent: netEvPercent,
        averageEv: netEvPercent,
        netEv: 0,
        grossEv: 0,
        pTrueSource: "cross_venue_ob",
        pTrueConfidence: 0.55,
        pTrueLowConfidence: false,
        evFormulaVersion: "kalshi_cross_venue_pm",
      });
    }
  }

  return null;
}

type OrderBookContext = {
  pmOb: Awaited<ReturnType<typeof getOrderBookMid>>;
  kalshiOb: Awaited<ReturnType<typeof getOrderBookMid>>;
  pmMid: number | null;
  kalshiMid: number | null;
};

async function loadOrderBookContext(
  tokenId: string | null,
  kalshiTicker: string | null,
  options?: { liveFallback?: boolean }
): Promise<OrderBookContext> {
  const liveFallback = options?.liveFallback ?? true;
  const pmKey = tokenId?.toLowerCase();
  const kalshiKey = kalshiTicker?.toUpperCase();

  const [pmObCached, kalshiObCached] = await Promise.all([
    pmKey
      ? getOrderBookMid(evRedisKeys.orderBookPm(pmKey))
      : Promise.resolve(null),
    kalshiKey
      ? getOrderBookMid(evRedisKeys.orderBookKalshi(kalshiKey))
      : Promise.resolve(null),
  ]);

  let pmOb = pmObCached;
  let kalshiOb = kalshiObCached;

  if (liveFallback) {
    if (!pmOb && pmKey) {
      pmOb = await fetchPolymarketClobOrderBookMid(pmKey);
    }
    if (!kalshiOb && kalshiKey) {
      kalshiOb = await fetchKalshiMarketOrderBookMid(kalshiKey);
    }
  }

  return {
    pmOb,
    kalshiOb,
    pmMid: pmOb?.mid ?? null,
    kalshiMid: kalshiOb?.mid ?? null,
  };
}

function hasLiveVenueOrderBook(
  ob: OrderBookContext["pmOb"],
  mid: number | null
): boolean {
  return ob != null && mid != null && Number.isFinite(mid);
}

async function enrichInputFromMappingCache(
  input: PipelineTradeEvInput
): Promise<PipelineTradeEvInput> {
  const tokenId = normalizePmTokenId(input.tokenId);
  const kalshiTicker = normalizeKalshiTicker(input.kalshiTicker);

  const mapping = await loadMappingForTradeEv(tokenId, kalshiTicker);
  return enrichPipelineEvInputFromMapping(input, mapping);
}

async function resolveTradeEvViaEnsemblePricing(
  lookupKey: string,
  enriched: PipelineTradeEvInput,
  mapping?: CachedMapping | null,
  ensembleLlmTimeoutMs?: number | null
): Promise<PipelineTradeEv | null> {
  let tokenId = normalizePmTokenId(enriched.tokenId);
  let kalshiTicker = normalizeKalshiTicker(enriched.kalshiTicker);

  if (enriched.source === "kalshi" && kalshiTicker && !tokenId) {
    tokenId = normalizePmTokenId(await resolvePmTokenForKalshi(kalshiTicker));
  }

  if (!tokenId && !kalshiTicker) return null;

  const books = await loadOrderBookContext(tokenId, kalshiTicker);
  const platform: EvPlatform =
    enriched.source === "kalshi" ? "kalshi" : "polymarket";
  const mappingPairKey =
    tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : null;

  const pTrueResult = await resolvePTrue({
    mappingPairKey,
    platform,
    tokenId,
    kalshiTicker,
    title: enriched.title,
    slug: enriched.slug,
    pmOb: books.pmOb,
    kalshiOb: books.kalshiOb,
    pmMid: books.pmMid,
    kalshiMid: books.kalshiMid,
    executionPrice: enriched.tradePrice,
    ensemblePTrue: authoritativeMappingEnsemblePTrue(mapping),
    fetchEnsemble: true,
    fetchExchangeConsensus: platform === "polymarket",
    computeEnsembleIfMissing: true,
    computeRagIfMissing: true,
    ensembleLlmTimeoutMs,
  });

  return attachAverageEvField(
    finalizePipelineTradeEv(
      buildPipelineTradeEvFromPTrue(lookupKey, pTrueResult, {
        platform,
        tokenId,
        kalshiTicker,
        mappingPairKey,
        executionPrice: enriched.tradePrice,
      }),
      lookupKey
    )
  );
}

async function resolveSportsExchangeMid(
  input: PipelineTradeEvInput,
  tokenId: string | null,
  mappingPairKey: string | null,
  books?: OrderBookContext | null,
  ensembleLlmTimeoutMs?: number | null
): Promise<number | null> {
  if (!tokenId || input.source !== "polymarket") return null;

  if (mappingPairKey) {
    const hasPmOb = hasLiveVenueOrderBook(books?.pmOb ?? null, books?.pmMid ?? null);
    const hasKalshiOb = hasLiveVenueOrderBook(
      books?.kalshiOb ?? null,
      books?.kalshiMid ?? null
    );
    if (hasPmOb && hasKalshiOb) {
      return null;
    }
  }

  const baseline = await lookupExchangeConsensusBaseline({
    tokenId,
    slug: input.slug,
    title: input.title,
    ensembleLlmTimeoutMs,
  });
  if (!baseline) return null;
  return Math.round(((baseline.yesBid + baseline.yesAsk) / 2) * 10000) / 10000;
}

async function applyPricingToResolvedTrade(
  record: PipelineTradeEv,
  input: PipelineTradeEvInput,
  books: OrderBookContext,
  exchangeMid: number | null = null,
  mapping?: CachedMapping | null
): Promise<PipelineTradeEv> {
  const tokenId = normalizePmTokenId(record.tokenId ?? input.tokenId);
  const kalshiTicker = normalizeKalshiTicker(
    record.kalshiTicker ?? input.kalshiTicker
  );
  const mappingPairKey =
    record.mappingPairKey ??
    (tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : null);
  const { ensemblePTrue, marketPrior } = await loadEnsemblePricingContext(
    tokenId,
    books,
    mapping
  );

  return applyExecutionPricingToTradeEv(record, {
    lookupKey: record.key,
    mappingPairKey,
    platform: input.source,
    pmOb: books.pmOb,
    kalshiOb: books.kalshiOb,
    pmMid: books.pmMid ?? record.pmMid ?? null,
    kalshiMid: books.kalshiMid ?? record.kalshiMid ?? null,
    exchangeMid,
    executionPrice: input.tradePrice,
    tokenId,
    kalshiTicker,
    ensemblePTrue:
      ensemblePTrue ??
      pickAuthoritativeEnsemblePTrue(record.pTrue) ??
      null,
    baselinePTrue:
      ensemblePTrue ??
      pickAuthoritativeEnsemblePTrue(record.pTrue) ??
      null,
    marketPrior,
  });
}

export async function resolvePipelineTradeEv(
  input: PipelineTradeEvInput,
  ensembleLlmTimeoutMs?: number | null
): Promise<PipelineTradeEv | null> {
  const enriched = await enrichInputFromMappingCache(input);
  const key = tradeEvKey(enriched);
  if (!key) return null;

  let tokenId = normalizePmTokenId(enriched.tokenId);
  const kalshiTicker = normalizeKalshiTicker(enriched.kalshiTicker);

  if (enriched.source === "kalshi" && kalshiTicker && !tokenId) {
    tokenId = normalizePmTokenId(await resolvePmTokenForKalshi(kalshiTicker));
  }

  const books = await loadOrderBookContext(tokenId, kalshiTicker);
  const executionPrice = normalizeIncomingTradePrice(enriched.tradePrice);
  const mappingPairKey =
    tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : null;
  const exchangeMid = await resolveSportsExchangeMid(
    enriched,
    tokenId,
    mappingPairKey,
    books,
    ensembleLlmTimeoutMs
  );
  const resolvedMapping = await loadMappingForTradeEv(tokenId, kalshiTicker);

  try {
    const cachedEv = await getTradeEvLookupRedisOnly(key);
    if (cachedEv?.status === "ok") {
      const priced = await applyPricingToResolvedTrade(
        finalizePipelineTradeEv({ ...cachedEv, key }, key),
        enriched,
        books,
        exchangeMid,
        resolvedMapping
      );
      if (
        priced.netEvPercent !== null &&
        priced.netEvPercent !== undefined &&
        (executionPrice != null || priced.netEvPercent !== 0)
      ) {
        return priced;
      }
    }
  } catch {
    // Fall through to live resolution.
  }

  if (!tokenId && !kalshiTicker) {
    return createUnmappedPipelineTradeEv(key, enriched);
  }

  const ensemblePriced = await resolveTradeEvViaEnsemblePricing(
    key,
    enriched,
    resolvedMapping,
    ensembleLlmTimeoutMs
  );
  if (ensemblePriced) {
    await cacheTradeEvLookup(key, ensemblePriced);
    return ensemblePriced;
  }

  return buildDynamicBaselineTradeEv(key, enriched);
}

export async function resolvePipelineTradeEvBatch(
  inputs: PipelineTradeEvInput[]
): Promise<PipelineTradeEv[]> {
  const results: PipelineTradeEv[] = [];

  for (const input of inputs) {
    const key = tradeEvKey(input);
    if (!key) continue;

    try {
      const row = await resolvePipelineTradeEv(input);
      results.push(row ?? createUnmappedPipelineTradeEv(key, input));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Batch EV Fetch Error:", message);
      results.push(createUnmappedPipelineTradeEv(key, input));
    }
  }

  return results;
}

export { tradeEvKey as pipelineTradeEvKey };
