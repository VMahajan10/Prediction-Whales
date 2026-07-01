import { desc, eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  marketMappings,
  trueProbabilities,
} from "@/lib/crossmarket/store/schema";
import type { EvPlatform } from "@/lib/finance/evEngine";
import {
  buildOkPipelineTradeEv,
  DEFAULT_P_MARKET_FALLBACK,
  DYNAMIC_BASELINE_NET_EV_DRAG,
  normalizeIncomingTradePrice,
  normalizePipelineTradeEv,
} from "@/lib/evPipeline/tradeEvRecord";
import {
  enrichPipelineEvInputFromMapping,
  normalizeKalshiTicker,
  normalizePmTokenId,
} from "@/lib/evPipeline/crossAssetLookup";
import {
  cacheTradeEvLookup,
  evRedisKeys,
  getMappingByKalshi,
  getMappingByPm,
  getOrderBookMid,
  getPTrue,
  getTradeEvLookupRedisOnly,
} from "@/lib/evPipeline/redisCache";
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
  };
}

/** On-the-fly 0% edge baseline when a trade token is not yet in localEvCache. */
export function buildDynamicBaselineTradeEv(
  searchKey: string,
  item?: PipelineTradeEvInput
): PipelineTradeEv {
  const lower = searchKey.toLowerCase();
  const realMarketPrice =
    normalizeIncomingTradePrice(item?.tradePrice) ?? DEFAULT_P_MARKET_FALLBACK;

  let tokenId: string | null = normalizePmTokenId(item?.tokenId);
  let kalshiTicker: string | null = normalizeKalshiTicker(item?.kalshiTicker);

  if (lower.startsWith("pm:")) {
    tokenId = normalizePmTokenId(searchKey.slice(3));
  } else if (lower.startsWith("kalshi:")) {
    kalshiTicker = normalizeKalshiTicker(searchKey.slice(7));
  }

  const baseline: PipelineTradeEv = {
    key: searchKey,
    status: "ok",
    tokenId,
    kalshiTicker,
    mappingPairKey: null,
    pMarket: realMarketPrice,
    pTrue: realMarketPrice,
    grossEv: 0,
    netEv: DYNAMIC_BASELINE_NET_EV_DRAG,
    grossEvPercent: 0,
    netEvPercent: 0,
  };

  console.log("⚠️ [Backend Zero EV]", {
    lookupKey: searchKey,
    pmMid: realMarketPrice,
    kalshiMid: undefined,
    pTrue: realMarketPrice,
    netEvPercent: 0,
  });

  return baseline;
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

async function resolvePTrue(tokenId: string): Promise<number | null> {
  try {
    const cached = await getPTrue(tokenId.toLowerCase());
    if (cached?.pTrue != null && Number.isFinite(cached.pTrue)) {
      return cached.pTrue;
    }
    return latestPTrueFromDb(tokenId);
  } catch {
    return null;
  }
}

async function resolvePMarket(
  platform: EvPlatform,
  tokenId: string | null,
  kalshiTicker: string | null,
  tradePrice?: number
): Promise<number | null> {
  try {
    if (platform === "polymarket" && tokenId) {
      const ob = await getOrderBookMid(
        evRedisKeys.orderBookPm(tokenId.toLowerCase())
      );
      if (ob?.mid != null && Number.isFinite(ob.mid)) return ob.mid;
    }

    if (platform === "kalshi" && kalshiTicker) {
      const ob = await getOrderBookMid(
        evRedisKeys.orderBookKalshi(kalshiTicker.toUpperCase())
      );
      if (ob?.mid != null && Number.isFinite(ob.mid)) return ob.mid;
    }

    if (tradePrice != null && Number.isFinite(tradePrice)) {
      return tradePrice;
    }

    return null;
  } catch {
    return null;
  }
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

export async function resolvePipelineTradeEv(
  input: PipelineTradeEvInput
): Promise<PipelineTradeEv | null> {
  const enriched = await enrichInputFromMappingCache(input);
  const key = tradeEvKey(enriched);
  if (!key) return null;

  try {
    const cachedEv = await getTradeEvLookupRedisOnly(key);
    if (cachedEv?.status === "ok") {
      const normalized = finalizePipelineTradeEv({ ...cachedEv, key }, key);
      if (normalized.netEvPercent !== null && normalized.netEvPercent !== undefined) {
        return normalized;
      }
    }
  } catch {
    // Fall through to live resolution.
  }

  let tokenId = normalizePmTokenId(enriched.tokenId);
  const kalshiTicker = normalizeKalshiTicker(enriched.kalshiTicker);

  if (enriched.source === "kalshi" && kalshiTicker && !tokenId) {
    tokenId = normalizePmTokenId(await resolvePmTokenForKalshi(kalshiTicker));
  }

  if (!tokenId) {
    return createUnmappedPipelineTradeEv(key, enriched);
  }

  const pTrue = await resolvePTrue(tokenId);
  if (pTrue == null) {
    return createUnmappedPipelineTradeEv(key, enriched);
  }

  const resolvedPMarket =
    (await resolvePMarket(
      enriched.source,
      tokenId,
      kalshiTicker,
      enriched.tradePrice
    )) ?? DEFAULT_P_MARKET_FALLBACK;

  const result = finalizePipelineTradeEv(
    buildOkPipelineTradeEv({
      lookupKey: key,
      platform: enriched.source,
      tokenId,
      kalshiTicker: kalshiTicker ?? "",
      pTrue,
      pMarket: resolvedPMarket,
    }),
    key
  );

  if (result.status === "ok") {
    await cacheTradeEvLookup(key, result);
  }

  return result;
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
