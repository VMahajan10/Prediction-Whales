import { desc, eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  marketMappings,
  trueProbabilities,
} from "@/lib/crossmarket/store/schema";
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
} from "@/lib/evPipeline/pricing";
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
  DEFAULT_P_MARKET_FALLBACK,
  normalizeIncomingTradePrice,
  normalizePipelineTradeEv,
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
  };
}

export function isFullyComputedTradeEv(
  payload: PipelineTradeEv | null | undefined
): payload is PipelineTradeEv & {
  status: "ok";
  netEvPercent: number;
  grossEvPercent: number;
  averageEv: number;
  pTrue: number;
} {
  return (
    payload != null &&
    payload.status === "ok" &&
    payload.netEvPercent != null &&
    Number.isFinite(payload.netEvPercent) &&
    payload.pTrue != null &&
    Number.isFinite(payload.pTrue)
  );
}

export function attachAverageEvField(
  payload: PipelineTradeEv
): PipelineTradeEv {
  if (payload.status !== "ok") return payload;
  const averageEv =
    payload.averageEv ??
    payload.netEvPercent ??
    payload.grossEvPercent ??
    null;
  const grossEvPercent =
    payload.grossEvPercent ?? payload.netEvPercent ?? averageEv;
  return {
    ...payload,
    averageEv,
    grossEvPercent,
    grossEv: payload.grossEv ?? payload.netEv ?? 0,
  };
}

export function buildTradeEvFromCachedMapping(
  lookupKey: string,
  mapping: CachedMapping,
  item: PipelineTradeEvInput
): PipelineTradeEv | null {
  const netEvPercent =
    mapping.netEvPercent ?? mapping.averageEv ?? mapping.grossEvPercent;
  if (netEvPercent == null || !Number.isFinite(netEvPercent)) return null;
  if (mapping.pTrue == null || !Number.isFinite(mapping.pTrue)) return null;

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
    averageEv: mapping.averageEv ?? netEvPercent,
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

  if (priced) return attachAverageEvField(priced);

  const fallbackPrice = executionPrice ?? DEFAULT_P_MARKET_FALLBACK;
  return attachAverageEvField({
    key: searchKey,
    status: "ok",
    tokenId,
    kalshiTicker,
    mappingPairKey: null,
    pMarket: fallbackPrice,
    pTrue: fallbackPrice,
    pmMid: platform === "polymarket" ? fallbackPrice : null,
    kalshiMid: platform === "kalshi" ? fallbackPrice : null,
    grossEv: 0,
    netEv: 0,
    grossEvPercent: 0,
    netEvPercent: 0,
    averageEv: 0,
  });
}

async function syncComputePricingEv(
  lookupKey: string,
  item: PipelineTradeEvInput,
  mapping?: CachedMapping | null
): Promise<PipelineTradeEv | null> {
  const enriched = mapping
    ? enrichPipelineEvInputFromMapping(item, mapping)
    : await enrichInputFromMappingCache(item);

  let tokenId = normalizePmTokenId(enriched.tokenId);
  let kalshiTicker = normalizeKalshiTicker(enriched.kalshiTicker);

  if (enriched.source === "kalshi" && kalshiTicker && !tokenId) {
    tokenId = normalizePmTokenId(await resolvePmTokenForKalshi(kalshiTicker));
  }

  if (!tokenId && !kalshiTicker) return null;

  const books = await loadOrderBookContext(tokenId, kalshiTicker);
  const executionPrice = normalizeIncomingTradePrice(enriched.tradePrice);
  const mappingPairKey =
    tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : null;
  const exchangeMid = await resolveSportsExchangeMid(
    enriched,
    tokenId,
    mappingPairKey
  );

  const priced = buildPipelineTradeEvFromPricing({
    lookupKey,
    platform: enriched.source,
    tokenId,
    kalshiTicker,
    mappingPairKey,
    pmOb: books.pmOb,
    kalshiOb: books.kalshiOb,
    pmMid: books.pmMid,
    kalshiMid: books.kalshiMid,
    exchangeMid,
    executionPrice: enriched.tradePrice,
  });

  if (priced) {
    const result = attachAverageEvField(
      finalizePipelineTradeEv(priced, lookupKey)
    );
    await cacheTradeEvLookup(lookupKey, result);
    return result;
  }

  if (!tokenId) return null;

  const dbPTrue = await latestPTrueFromDb(tokenId);
  if (dbPTrue == null) return null;

  const fallback = buildPipelineTradeEvFromPricing({
    lookupKey,
    platform: enriched.source,
    tokenId,
    kalshiTicker,
    mappingPairKey,
    pmOb: books.pmOb,
    kalshiOb: books.kalshiOb,
    pmMid: books.pmMid ?? dbPTrue,
    kalshiMid: books.kalshiMid ?? dbPTrue,
    exchangeMid,
    executionPrice: enriched.tradePrice,
  });

  if (!fallback) return null;

  const result = attachAverageEvField(
    finalizePipelineTradeEv(fallback, lookupKey)
  );
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
      })
    );
  }

  return payload;
}

/**
 * Resolve trade EV for API responses — always returns numeric EV for mapped markets.
 * Reads precomputed pipeline cache first; sync-computes before responding on cache miss.
 */
export async function ensureFullyComputedTradeEv(
  lookupKey: string,
  item: PipelineTradeEvInput,
  mapping?: CachedMapping | null
): Promise<PipelineTradeEv> {
  const resolvedMapping =
    mapping ??
    (await loadMappingForTradeEv(item.tokenId, item.kalshiTicker));

  const tryFinalize = (record: PipelineTradeEv | null | undefined) => {
    if (!record) return null;
    const payload = finalizeApiTradeEv(record, lookupKey, item);
    return isFullyComputedTradeEv(payload) ? payload : null;
  };

  const localHit = tryFinalize(readLocalTradeEvLookup(lookupKey, item.source));
  if (localHit) return localHit;

  const storeHit = tryFinalize(await getTradeEvLookup(lookupKey));
  if (storeHit) {
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

  const syncPriced = tryFinalize(
    await syncComputePricingEv(lookupKey, item, resolvedMapping)
  );
  if (syncPriced) return syncPriced;

  try {
    const resolved = await resolvePipelineTradeEv(item);
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

    const retryLocal = tryFinalize(
      readLocalTradeEvLookup(lookupKey, item.source)
    );
    if (retryLocal) return retryLocal;

    const retryStore = tryFinalize(await getTradeEvLookup(lookupKey));
    if (retryStore) return retryStore;
  }

  if (resolvedMapping) {
    console.warn(
      `[ev/trades] Mapped market ${lookupKey} missing precomputed EV after sync attempts`
    );
  }

  return createUnmappedPipelineTradeEv(lookupKey, item);
}

async function latestPTrueFromDb(tokenId: string): Promise<number | null> {
  if (!isDatabaseEnabled()) return null;
  try {
    const db = getDb();
    const rows = await db
      .select({ pTrue: trueProbabilities.pTrue })
      .from(trueProbabilities)
      .where(eq(trueProbabilities.polymarketTokenId, tokenId.toLowerCase()))
      .orderBy(desc(trueProbabilities.calculatedAt))
      .limit(1);
    const raw = rows[0]?.pTrue;
    if (raw == null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

async function loadOrderBookContext(
  tokenId: string | null,
  kalshiTicker: string | null
): Promise<{
  pmOb: Awaited<ReturnType<typeof getOrderBookMid>>;
  kalshiOb: Awaited<ReturnType<typeof getOrderBookMid>>;
  pmMid: number | null;
  kalshiMid: number | null;
}> {
  const [pmOb, kalshiOb] = await Promise.all([
    tokenId
      ? getOrderBookMid(evRedisKeys.orderBookPm(tokenId.toLowerCase()))
      : Promise.resolve(null),
    kalshiTicker
      ? getOrderBookMid(evRedisKeys.orderBookKalshi(kalshiTicker.toUpperCase()))
      : Promise.resolve(null),
  ]);

  return {
    pmOb,
    kalshiOb,
    pmMid: pmOb?.mid ?? null,
    kalshiMid: kalshiOb?.mid ?? null,
  };
}

async function enrichInputFromMappingCache(
  input: PipelineTradeEvInput
): Promise<PipelineTradeEvInput> {
  const tokenId = normalizePmTokenId(input.tokenId);
  const kalshiTicker = normalizeKalshiTicker(input.kalshiTicker);

  const mapping = await loadMappingForTradeEv(tokenId, kalshiTicker);
  return enrichPipelineEvInputFromMapping(input, mapping);
}

async function resolveSportsExchangeMid(
  input: PipelineTradeEvInput,
  tokenId: string | null,
  mappingPairKey: string | null
): Promise<number | null> {
  if (mappingPairKey || !tokenId || input.source !== "polymarket") return null;
  const baseline = await lookupExchangeConsensusBaseline({ tokenId });
  if (!baseline) return null;
  return Math.round(((baseline.yesBid + baseline.yesAsk) / 2) * 10000) / 10000;
}

function applyPricingToResolvedTrade(
  record: PipelineTradeEv,
  input: PipelineTradeEvInput,
  books: Awaited<ReturnType<typeof loadOrderBookContext>>,
  exchangeMid: number | null = null
): PipelineTradeEv {
  const tokenId = normalizePmTokenId(record.tokenId ?? input.tokenId);
  const kalshiTicker = normalizeKalshiTicker(
    record.kalshiTicker ?? input.kalshiTicker
  );
  const mappingPairKey =
    record.mappingPairKey ??
    (tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : null);

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
  });
}

export async function resolvePipelineTradeEv(
  input: PipelineTradeEvInput
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
    mappingPairKey
  );

  try {
    const cachedEv = await getTradeEvLookupRedisOnly(key);
    if (cachedEv?.status === "ok") {
      const priced = applyPricingToResolvedTrade(
        finalizePipelineTradeEv({ ...cachedEv, key }, key),
        enriched,
        books,
        exchangeMid
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

  const priced = buildPipelineTradeEvFromPricing({
    lookupKey: key,
    platform: enriched.source,
    tokenId,
    kalshiTicker,
    mappingPairKey,
    pmOb: books.pmOb,
    kalshiOb: books.kalshiOb,
    pmMid: books.pmMid,
    kalshiMid: books.kalshiMid,
    exchangeMid,
    executionPrice: enriched.tradePrice,
  });

  if (priced) {
    const result = finalizePipelineTradeEv(priced, key);
    await cacheTradeEvLookup(key, result);
    return result;
  }

  if (!tokenId) {
    return createUnmappedPipelineTradeEv(key, enriched);
  }

  const dbPTrue = await latestPTrueFromDb(tokenId);
  if (dbPTrue == null) {
    return buildDynamicBaselineTradeEv(key, enriched);
  }

  const fallback = buildPipelineTradeEvFromPricing({
    lookupKey: key,
    platform: enriched.source,
    tokenId,
    kalshiTicker,
    mappingPairKey,
    pmOb: books.pmOb,
    kalshiOb: books.kalshiOb,
    pmMid: books.pmMid ?? dbPTrue,
    kalshiMid: books.kalshiMid ?? dbPTrue,
    exchangeMid,
    executionPrice: enriched.tradePrice,
  });

  if (fallback) {
    const result = finalizePipelineTradeEv(fallback, key);
    await cacheTradeEvLookup(key, result);
    return result;
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
