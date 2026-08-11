import { desc, ne } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { marketMappings } from "@/lib/crossmarket/store/schema";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import {
  calculateMidpoint,
  type OrderBook,
  type OrderBookLevel,
} from "@/lib/finance/evEngine";
import { fetchKalshiMarketDetail } from "@/lib/kalshiDetail";
import { fetchKalshiTrades } from "@/lib/kalshiTradesServer";
import { sleep } from "@/lib/kalshi/http";
import { fetchWhaleBackfill } from "@/lib/polymarket";
import { MIN_WHALE_USD } from "@/lib/whaleTrades";
import {
  cacheOrderBookMidBatch,
  evRedisKeys,
  isEvRedisEnabled,
  type CachedOrderBookMid,
} from "@/lib/evPipeline/redisCache";

const CLOB_BOOK_URL = "https://clob.polymarket.com/book";
const TEST_FALLBACK_MATCH_METHOD = "TEST_FALLBACK_PAIR";
const MAX_HOT_PM_TOKENS = 400;
const MAX_HOT_KALSHI_TICKERS = 400;
const INGEST_CONCURRENCY = 16;
const KALSHI_INGEST_CONCURRENCY = 5;
const KALSHI_TICKER_DELAY_MS = 100;
const FETCH_TIMEOUT_MS = 6_000;
const REDIS_FLUSH_CHUNK = 200;

export interface HotOrderBookTargets {
  pmTokenIds: string[];
  kalshiTickers: string[];
}

interface ClobBookLevel {
  price: string;
  size: string;
}

interface ClobBookResponse {
  bids?: ClobBookLevel[];
  asks?: ClobBookLevel[];
}

function parseBookLevels(
  rows: ClobBookLevel[] | undefined
): OrderBookLevel[] {
  const levels: OrderBookLevel[] = [];
  for (const row of rows ?? []) {
    const price = parseFloat(row.price);
    const size = parseFloat(row.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) {
      continue;
    }
    levels.push([price, size]);
  }
  return levels;
}

function orderBookMidFromTouch(
  bid: number | null,
  ask: number | null
): CachedOrderBookMid | null {
  if (
    bid == null ||
    ask == null ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid <= 0 ||
    ask <= 0 ||
    bid >= ask
  ) {
    return null;
  }
  const mid = (bid + ask) / 2;
  return {
    bid,
    ask,
    mid,
    ts: Date.now(),
  };
}

/** Polymarket CLOB best bid/ask → microprice mid. */
export async function fetchPolymarketClobOrderBookMid(
  tokenId: string
): Promise<CachedOrderBookMid | null> {
  const url = `${CLOB_BOOK_URL}?token_id=${encodeURIComponent(tokenId)}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Accept: "application/json" },
      timeoutMs: FETCH_TIMEOUT_MS,
      cache: "no-store",
    });
    if (!res.ok) return null;

    const data = (await res.json()) as ClobBookResponse;
    const book: OrderBook = {
      bids: parseBookLevels(data.bids),
      asks: parseBookLevels(data.asks),
    };
    const midResult = calculateMidpoint(book);
    if (!midResult) return null;

    return {
      bid: midResult.bestBid,
      ask: midResult.bestAsk,
      mid: midResult.midpoint,
      ts: Date.now(),
    };
  } catch {
    return null;
  }
}

/** Kalshi `/markets/{ticker}` touch quotes → resting mid. */
export async function fetchKalshiMarketOrderBookMid(
  ticker: string
): Promise<CachedOrderBookMid | null> {
  try {
    const market = await fetchKalshiMarketDetail(ticker.toUpperCase());
    if (!market) return null;
    return orderBookMidFromTouch(market.yesBid, market.yesAsk);
  } catch {
    return null;
  }
}

async function loadMappingHotTargets(): Promise<HotOrderBookTargets> {
  const pmTokenIds = new Set<string>();
  const kalshiTickers = new Set<string>();

  if (!isDatabaseEnabled()) {
    return { pmTokenIds: [], kalshiTickers: [] };
  }

  try {
    const db = getDb();
    const rows = await db
      .select({
        polymarketTokenId: marketMappings.polymarketTokenId,
        kalshiTicker: marketMappings.kalshiTicker,
      })
      .from(marketMappings)
      .where(ne(marketMappings.matchMethod, TEST_FALLBACK_MATCH_METHOD))
      .orderBy(desc(marketMappings.confidenceScore))
      .limit(MAX_HOT_PM_TOKENS);

    for (const row of rows) {
      if (row.polymarketTokenId) {
        pmTokenIds.add(row.polymarketTokenId.toLowerCase());
      }
      if (row.kalshiTicker) {
        kalshiTickers.add(row.kalshiTicker.toUpperCase());
      }
    }
  } catch (err) {
    console.warn(
      "[ev-pipeline] ingestOrderBooks mapping enumeration failed:",
      err instanceof Error ? err.message : err
    );
  }

  return {
    pmTokenIds: Array.from(pmTokenIds),
    kalshiTickers: Array.from(kalshiTickers),
  };
}

async function loadWhaleHotTargets(): Promise<HotOrderBookTargets> {
  const pmTokenIds = new Set<string>();
  const kalshiTickers = new Set<string>();

  const [pmResult, kalshiResult] = await Promise.allSettled([
    fetchWhaleBackfill(),
    fetchKalshiTrades(undefined, { bypassThrottle: true }),
  ]);

  if (pmResult.status === "fulfilled") {
    for (const trade of pmResult.value) {
      if (trade.assetId) {
        pmTokenIds.add(trade.assetId.toLowerCase());
      }
    }
  } else {
    console.warn(
      "[ev-pipeline] ingestOrderBooks PM whale enumeration failed:",
      pmResult.reason instanceof Error
        ? pmResult.reason.message
        : pmResult.reason
    );
  }

  if (kalshiResult.status === "fulfilled") {
    for (const trade of kalshiResult.value) {
      if (
        trade.ticker &&
        trade.usdNotional >= MIN_WHALE_USD
      ) {
        kalshiTickers.add(trade.ticker.toUpperCase());
      }
    }
  } else {
    console.warn(
      "[ev-pipeline] ingestOrderBooks Kalshi whale enumeration failed:",
      kalshiResult.reason instanceof Error
        ? kalshiResult.reason.message
        : kalshiResult.reason
    );
  }

  return {
    pmTokenIds: Array.from(pmTokenIds),
    kalshiTickers: Array.from(kalshiTickers),
  };
}

/** Active mappings plus recent whale feed assets. */
export async function enumerateHotOrderBookTargets(): Promise<HotOrderBookTargets> {
  const [mappingTargets, whaleTargets] = await Promise.all([
    loadMappingHotTargets(),
    loadWhaleHotTargets(),
  ]);

  const pmTokenIds = new Set<string>([
    ...mappingTargets.pmTokenIds,
    ...whaleTargets.pmTokenIds,
  ]);
  const kalshiTickers = new Set<string>([
    ...mappingTargets.kalshiTickers,
    ...whaleTargets.kalshiTickers,
  ]);

  return {
    pmTokenIds: Array.from(pmTokenIds).slice(0, MAX_HOT_PM_TOKENS),
    kalshiTickers: Array.from(kalshiTickers).slice(0, MAX_HOT_KALSHI_TICKERS),
  };
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

async function flushOrderBookEntries(
  entries: Array<{ key: string; value: CachedOrderBookMid }>
): Promise<void> {
  for (let i = 0; i < entries.length; i += REDIS_FLUSH_CHUNK) {
    await cacheOrderBookMidBatch(entries.slice(i, i + REDIS_FLUSH_CHUNK));
  }
}

export interface OrderBookIngestResult {
  pmRequested: number;
  kalshiRequested: number;
  pmCached: number;
  kalshiCached: number;
  totalCached: number;
}

/**
 * Fetch live PM CLOB + Kalshi market quotes and cache mids in Redis (10s TTL).
 */
export async function runOrderBookIngest(): Promise<OrderBookIngestResult> {
  if (!isEvRedisEnabled()) {
    console.warn("[ev-pipeline] ingestOrderBooks skipped — Redis not configured");
    return {
      pmRequested: 0,
      kalshiRequested: 0,
      pmCached: 0,
      kalshiCached: 0,
      totalCached: 0,
    };
  }

  const targets = await enumerateHotOrderBookTargets();
  const entries: Array<{ key: string; value: CachedOrderBookMid }> = [];
  let pmCached = 0;
  let kalshiCached = 0;

  await runPool(targets.pmTokenIds, INGEST_CONCURRENCY, async (tokenId) => {
    const snapshot = await fetchPolymarketClobOrderBookMid(tokenId);
    if (!snapshot) return;
    entries.push({
      key: evRedisKeys.orderBookPm(tokenId),
      value: snapshot,
    });
    pmCached += 1;
  });

  await runPool(targets.kalshiTickers, KALSHI_INGEST_CONCURRENCY, async (ticker) => {
    const snapshot = await fetchKalshiMarketOrderBookMid(ticker);
    if (snapshot) {
      entries.push({
        key: evRedisKeys.orderBookKalshi(ticker),
        value: snapshot,
      });
      kalshiCached += 1;
    }
    await sleep(KALSHI_TICKER_DELAY_MS);
  });

  if (entries.length > 0) {
    await flushOrderBookEntries(entries);
  }

  const result: OrderBookIngestResult = {
    pmRequested: targets.pmTokenIds.length,
    kalshiRequested: targets.kalshiTickers.length,
    pmCached,
    kalshiCached,
    totalCached: pmCached + kalshiCached,
  };

  console.info(
    `[ev-pipeline] ingestOrderBooks cached ${result.totalCached} snapshot(s) ` +
      `(pm ${result.pmCached}/${result.pmRequested}, kalshi ${result.kalshiCached}/${result.kalshiRequested})`
  );

  return result;
}
