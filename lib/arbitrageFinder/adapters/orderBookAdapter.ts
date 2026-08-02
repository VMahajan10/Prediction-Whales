/**
 * Order book access for the arbitrage finder.
 * Reads Redis when available; falls back to live PM CLOB + Kalshi quotes on cache miss.
 */

import type { ArbPairOrderBooks } from "@/lib/arbitrageFinder/types";
import {
  normalizeKalshiTicker,
  normalizePmTokenId,
} from "@/lib/evPipeline/crossAssetLookup";
import {
  fetchKalshiMarketOrderBookMid,
  fetchPolymarketClobOrderBookMid,
} from "@/lib/evPipeline/orderBookIngest";
import {
  evRedisKeys,
  getOrderBookMid,
  mappingRedisPairKey,
  type CachedOrderBookMid,
  type MappingRedisPrefetch,
} from "@/lib/evPipeline/redisCache";
import { sleep } from "@/lib/kalshi/http";

const PM_LIVE_FETCH_CONCURRENCY = 12;
const KALSHI_LIVE_FETCH_CONCURRENCY = 4;
const KALSHI_LIVE_FETCH_DELAY_MS = 100;

export interface OrderBookResolveOptions {
  /** When true (default), fetch live quotes for cache misses. */
  liveFallback?: boolean;
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) break;
        await worker(items[index]);
      }
    }
  );
  await Promise.all(runners);
}

async function readCachedPmOrderBookMid(
  polymarketTokenId: string
): Promise<CachedOrderBookMid | null> {
  const tokenId = normalizePmTokenId(polymarketTokenId);
  if (!tokenId) return null;
  return getOrderBookMid(evRedisKeys.orderBookPm(tokenId));
}

async function readCachedKalshiOrderBookMid(
  kalshiTicker: string
): Promise<CachedOrderBookMid | null> {
  const ticker = normalizeKalshiTicker(kalshiTicker);
  if (!ticker) return null;
  return getOrderBookMid(evRedisKeys.orderBookKalshi(ticker));
}

async function fetchLivePmOrderBookMid(
  polymarketTokenId: string
): Promise<CachedOrderBookMid | null> {
  const tokenId = normalizePmTokenId(polymarketTokenId);
  if (!tokenId) return null;
  return fetchPolymarketClobOrderBookMid(tokenId);
}

async function fetchLiveKalshiOrderBookMid(
  kalshiTicker: string
): Promise<CachedOrderBookMid | null> {
  const ticker = normalizeKalshiTicker(kalshiTicker);
  if (!ticker) return null;
  return fetchKalshiMarketOrderBookMid(ticker);
}

/** PM book: Redis cache first, then live CLOB on miss. */
export async function fetchPmOrderBookMid(
  polymarketTokenId: string,
  options: OrderBookResolveOptions = {}
): Promise<CachedOrderBookMid | null> {
  const cached = await readCachedPmOrderBookMid(polymarketTokenId);
  if (cached || options.liveFallback === false) return cached;
  return fetchLivePmOrderBookMid(polymarketTokenId);
}

/** Kalshi book: Redis cache first, then live market quotes on miss. */
export async function fetchKalshiOrderBookMid(
  kalshiTicker: string,
  options: OrderBookResolveOptions = {}
): Promise<CachedOrderBookMid | null> {
  const cached = await readCachedKalshiOrderBookMid(kalshiTicker);
  if (cached || options.liveFallback === false) return cached;
  return fetchLiveKalshiOrderBookMid(kalshiTicker);
}

/** Load PM + Kalshi books concurrently for a mapped pair. */
export async function fetchPairOrderBooks(
  polymarketTokenId: string,
  kalshiTicker: string,
  options: OrderBookResolveOptions = {}
): Promise<ArbPairOrderBooks> {
  const [pmOb, kalshiOb] = await Promise.all([
    fetchPmOrderBookMid(polymarketTokenId, options),
    fetchKalshiOrderBookMid(kalshiTicker, options),
  ]);
  return { pmOb, kalshiOb };
}

/**
 * Merge Redis prefetch with batched live fetches for cache misses.
 * Dedupes by token/ticker within the scan so shared assets fetch once.
 */
export async function hydrateOrderBooksForMappings(
  mappings: Array<{ polymarketTokenId: string; kalshiTicker: string }>,
  redisPrefetch: Map<string, MappingRedisPrefetch>,
  options: OrderBookResolveOptions = {}
): Promise<Map<string, ArbPairOrderBooks>> {
  const liveFallback = options.liveFallback !== false;
  const byPair = new Map<string, ArbPairOrderBooks>();
  const missingPm = new Set<string>();
  const missingKalshi = new Set<string>();

  for (const mapping of mappings) {
    const tokenId = normalizePmTokenId(mapping.polymarketTokenId);
    const ticker = normalizeKalshiTicker(mapping.kalshiTicker);
    const pairKey =
      tokenId && ticker
        ? mappingRedisPairKey(tokenId, ticker)
        : mappingRedisPairKey(
            mapping.polymarketTokenId,
            mapping.kalshiTicker
          );

    const prefetched = redisPrefetch.get(pairKey);
    const pmOb = prefetched?.pmOb ?? null;
    const kalshiOb = prefetched?.kalshiOb ?? null;
    byPair.set(pairKey, { pmOb, kalshiOb });

    if (liveFallback) {
      if (!pmOb && tokenId) missingPm.add(tokenId);
      if (!kalshiOb && ticker) missingKalshi.add(ticker);
    }
  }

  if (!liveFallback || (missingPm.size === 0 && missingKalshi.size === 0)) {
    return byPair;
  }

  const pmLive = new Map<string, CachedOrderBookMid | null>();
  const kalshiLive = new Map<string, CachedOrderBookMid | null>();

  await runPool(Array.from(missingPm), PM_LIVE_FETCH_CONCURRENCY, async (tokenId) => {
    pmLive.set(tokenId, await fetchPolymarketClobOrderBookMid(tokenId));
  });

  await runPool(
    Array.from(missingKalshi),
    KALSHI_LIVE_FETCH_CONCURRENCY,
    async (ticker) => {
      kalshiLive.set(ticker, await fetchKalshiMarketOrderBookMid(ticker));
      await sleep(KALSHI_LIVE_FETCH_DELAY_MS);
    }
  );

  let pmHydrated = 0;
  let kalshiHydrated = 0;

  for (const mapping of mappings) {
    const tokenId = normalizePmTokenId(mapping.polymarketTokenId);
    const ticker = normalizeKalshiTicker(mapping.kalshiTicker);
    const pairKey =
      tokenId && ticker
        ? mappingRedisPairKey(tokenId, ticker)
        : mappingRedisPairKey(
            mapping.polymarketTokenId,
            mapping.kalshiTicker
          );
    const books = byPair.get(pairKey);
    if (!books) continue;

    if (!books.pmOb && tokenId && pmLive.has(tokenId)) {
      books.pmOb = pmLive.get(tokenId) ?? null;
      if (books.pmOb) pmHydrated += 1;
    }
    if (!books.kalshiOb && ticker && kalshiLive.has(ticker)) {
      books.kalshiOb = kalshiLive.get(ticker) ?? null;
      if (books.kalshiOb) kalshiHydrated += 1;
    }
  }

  if (pmHydrated > 0 || kalshiHydrated > 0) {
    console.info(
      `[arb-finder] live order book hydration: pm=${pmHydrated}/${missingPm.size} kalshi=${kalshiHydrated}/${missingKalshi.size}`
    );
  }

  return byPair;
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
