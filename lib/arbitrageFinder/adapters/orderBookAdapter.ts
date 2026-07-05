/**
 * Read-only order book access for the arbitrage finder.
 * Does not write to Redis or the EV pipeline.
 */

import type { CachedOrderBookMid } from "@/lib/evPipeline/redisCache";
import {
  evRedisKeys,
  getOrderBookMid,
} from "@/lib/evPipeline/redisCache";
import {
  normalizeKalshiTicker,
  normalizePmTokenId,
} from "@/lib/evPipeline/crossAssetLookup";
import type { ArbPairOrderBooks } from "@/lib/arbitrageFinder/types";

export async function fetchPmOrderBookMid(
  polymarketTokenId: string
): Promise<CachedOrderBookMid | null> {
  const tokenId = normalizePmTokenId(polymarketTokenId);
  if (!tokenId) return null;
  return getOrderBookMid(evRedisKeys.orderBookPm(tokenId));
}

export async function fetchKalshiOrderBookMid(
  kalshiTicker: string
): Promise<CachedOrderBookMid | null> {
  const ticker = normalizeKalshiTicker(kalshiTicker);
  if (!ticker) return null;
  return getOrderBookMid(evRedisKeys.orderBookKalshi(ticker));
}

/** Load PM + Kalshi books concurrently for a mapped pair. */
export async function fetchPairOrderBooks(
  polymarketTokenId: string,
  kalshiTicker: string
): Promise<ArbPairOrderBooks> {
  const [pmOb, kalshiOb] = await Promise.all([
    fetchPmOrderBookMid(polymarketTokenId),
    fetchKalshiOrderBookMid(kalshiTicker),
  ]);
  return { pmOb, kalshiOb };
}

export function maxOrderBookStalenessMs(
  books: ArbPairOrderBooks,
  nowMs = Date.now()
): number {
  const ages: number[] = [];
  if (books.pmOb?.ts) ages.push(nowMs - books.pmOb.ts);
  if (books.kalshiOb?.ts) ages.push(nowMs - books.kalshiOb.ts);
  return ages.length > 0 ? Math.max(...ages) : Number.POSITIVE_INFINITY;
}
