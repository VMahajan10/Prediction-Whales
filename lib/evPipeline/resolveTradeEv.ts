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
  normalizePipelineTradeEv,
} from "@/lib/evPipeline/tradeEvRecord";
import {
  cacheTradeEvLookup,
  evRedisKeys,
  getMappingByKalshi,
  getOrderBookMid,
  getPTrue,
  getTradeEvLookup,
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
    tokenId: input?.tokenId?.toLowerCase() ?? null,
    kalshiTicker: input?.kalshiTicker?.toUpperCase() ?? null,
    netEvPercent: null,
    netEv: 0,
    grossEv: 0,
    grossEvPercent: null,
    pTrue: null,
    pMarket: null,
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

export async function resolvePipelineTradeEv(
  input: PipelineTradeEvInput
): Promise<PipelineTradeEv | null> {
  const key = tradeEvKey(input);
  if (!key) return null;

  try {
    const cachedEv = await getTradeEvLookup(key);
    if (cachedEv?.status === "ok") {
      const normalized = finalizePipelineTradeEv({ ...cachedEv, key }, key);
      if (normalized.netEvPercent !== null && normalized.netEvPercent !== undefined) {
        return normalized;
      }
    }
  } catch {
    // Fall through to live resolution.
  }

  let tokenId = input.tokenId?.toLowerCase() ?? null;
  const kalshiTicker = input.kalshiTicker?.toUpperCase() ?? null;

  if (input.source === "kalshi" && kalshiTicker && !tokenId) {
    tokenId = await resolvePmTokenForKalshi(kalshiTicker);
  }

  if (!tokenId) {
    return createUnmappedPipelineTradeEv(key, input);
  }

  const pTrue = await resolvePTrue(tokenId);
  if (pTrue == null) {
    return createUnmappedPipelineTradeEv(key, input);
  }

  const resolvedPMarket =
    (await resolvePMarket(
      input.source,
      tokenId,
      kalshiTicker,
      input.tradePrice
    )) ?? DEFAULT_P_MARKET_FALLBACK;

  const result = finalizePipelineTradeEv(
    buildOkPipelineTradeEv({
      lookupKey: key,
      platform: input.source,
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
