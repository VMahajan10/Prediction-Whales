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
import {
  cacheTradeEvLookup,
  evRedisKeys,
  getMappingByKalshi,
  getMappingByPm,
  getOrderBookMid,
  getTradeEvLookupRedisOnly,
} from "@/lib/evPipeline/redisCache";
import {
  DEFAULT_P_MARKET_FALLBACK,
  normalizeIncomingTradePrice,
  normalizePipelineTradeEv,
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
    pTrue: null,
    pMarket: null,
    pmMid: null,
    kalshiMid: null,
  };
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

  if (priced) return priced;

  const fallbackPrice = executionPrice ?? DEFAULT_P_MARKET_FALLBACK;
  return {
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
  };
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

  if (input.source === "polymarket" && tokenId && !kalshiTicker) {
    const mapping = await getMappingByPm(tokenId);
    return enrichPipelineEvInputFromMapping(input, mapping);
  }

  if (input.source === "kalshi" && kalshiTicker && !tokenId) {
    const mapping = await getMappingByKalshi(kalshiTicker);
    return enrichPipelineEvInputFromMapping(input, mapping);
  }

  return input;
}

function applyPricingToResolvedTrade(
  record: PipelineTradeEv,
  input: PipelineTradeEvInput,
  books: Awaited<ReturnType<typeof loadOrderBookContext>>
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

  try {
    const cachedEv = await getTradeEvLookupRedisOnly(key);
    if (cachedEv?.status === "ok") {
      const priced = applyPricingToResolvedTrade(
        finalizePipelineTradeEv({ ...cachedEv, key }, key),
        enriched,
        books
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
