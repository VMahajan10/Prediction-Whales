import "server-only";

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { mapWithConcurrency } from "@/lib/clvPriceHistory";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  feedTrades,
  kalshiShadowTrades,
  type KalshiShadowTrade,
} from "@/lib/crossmarket/store/schema";
import {
  isKalshiTradeEligibleForFeed,
  kalshiFeedTradeToWhale,
} from "@/lib/feed/kalshiFeedTrades";
import {
  meetsFeedTradeEvThreshold,
  MIN_FEED_TRADE_EV_PCT,
  MIN_PRODUCT_FEED_STAKE_USD,
  resolvePolymarketTradeNotionalUsd,
} from "@/lib/feedQualification";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import { initGlobalLocalEvCache } from "@/lib/evPipeline/redisCache";
import { ensureFullyComputedTradeEv } from "@/lib/evPipeline/resolveTradeEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  normalizePipelineLookupKey,
  pipelineEvLookupKey,
} from "@/lib/evPipeline/types";
import type { FeedTrade } from "@/lib/feedTradeTypes";
import {
  isTrendingByStakeAndRecency,
  tradeCategoryForTab,
  type MarketFeedCategory,
  type RecentFeedCategoryFilter,
} from "@/lib/constants/categories";

initGlobalLocalEvCache();

export const RECENT_TRADES_LIMIT = 20;
const RECENT_TRADES_HOUR_MS = 60 * 60 * 1000;
const POLYMARKET_FALLBACK_READ_LIMIT = 40;

/** Raised when a per-source DB read fails — collected into `degraded` instead of silent []. */
export class RecentTradesReadError extends Error {
  readonly source: "polymarket" | "kalshi";
  readonly cause: unknown;

  constructor(source: "polymarket" | "kalshi", cause: unknown) {
    const detail =
      cause instanceof Error ? cause.message : String(cause);
    super(`[recentTrades] ${source} read failed: ${detail}`);
    this.name = "RecentTradesReadError";
    this.source = source;
    this.cause = cause;
  }
}

export type FetchRecentFeedTradesResult = {
  trades: RecentFeedTrade[];
  degraded: string[];
};

export type { RecentFeedCategoryFilter } from "@/lib/constants/categories";

type RecentFetchOptions = {
  limit?: number;
  since?: Date;
  excludeKeys?: Set<string>;
  categoryFilter?: RecentFeedCategoryFilter;
};

function recentTradeDedupeKey(trade: RecentFeedTrade): string {
  if (trade.source === "kalshi") return `kalshi:${trade.id}`;
  return trade.transactionHash?.trim() || trade.id;
}

function dedupeRecentTrades(trades: RecentFeedTrade[]): RecentFeedTrade[] {
  const seen = new Set<string>();
  return trades.filter((trade) => {
    const key = recentTradeDedupeKey(trade);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function combineRecentTrades(
  polymarket: RecentFeedTrade[],
  kalshi: RecentFeedTrade[],
  limit = RECENT_TRADES_LIMIT
): RecentFeedTrade[] {
  return dedupeRecentTrades([...polymarket, ...kalshi])
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

function dbCategoryForFilter(
  filter: RecentFeedCategoryFilter
): MarketFeedCategory | null {
  return tradeCategoryForTab(filter);
}

function isTrendingRecentTrade(
  trade: RecentFeedTrade,
  nowEpochSec = Math.floor(Date.now() / 1000)
): boolean {
  return isTrendingByStakeAndRecency(trade.usdNotional, trade.timestamp, nowEpochSec * 1000);
}

function applyRecentCategoryFilter(
  trades: RecentFeedTrade[],
  filter: RecentFeedCategoryFilter
): RecentFeedTrade[] {
  if (filter === "all") return trades;
  if (filter === "trending") {
    const now = Math.floor(Date.now() / 1000);
    return trades.filter((trade) => isTrendingRecentTrade(trade, now));
  }

  const expected = dbCategoryForFilter(filter);
  if (!expected) return trades;

  return trades.filter((trade) => trade.category === expected);
}

/** Max Kalshi rows to read before in-memory EV filter (DB has no EV column). */
const KALSHI_DB_READ_LIMIT = 60;
/** Max Kalshi rows to fully EV-compute when cache is cold (supplemental paths only). */
const KALSHI_EV_COMPUTE_LIMIT = 20;

export type RecentFeedTrade = FeedTrade & {
  /** Trade-level EV % — lets the client gate before pipeline hydration. */
  netEvPercent?: number | null;
};

type PolymarketPayload = {
  id?: string;
  title?: string;
  outcome?: string;
  side?: "BUY" | "SELL";
  price?: number;
  size?: number;
  timestamp?: number;
  transactionHash?: string;
  slug?: string;
  assetId?: string;
};

function polymarketPayloadToFeedTrade(
  payload: unknown,
  averageEv?: number,
  category?: string | null
): RecentFeedTrade | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as PolymarketPayload;
  const id = row.id?.trim();
  if (!id) return null;

  const price = Number(row.price);
  const size = Number(row.size);
  const timestamp = Number(row.timestamp);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(size) ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0
  ) {
    return null;
  }

  const usdNotional = resolvePolymarketTradeNotionalUsd({ price, size });
  if (usdNotional <= 0) return null;

  const netEvPercent =
    averageEv != null && Number.isFinite(averageEv)
      ? averageEv
      : typeof (row as { netEvPercent?: number }).netEvPercent === "number"
        ? (row as { netEvPercent: number }).netEvPercent
        : typeof (row as { averageEv?: number }).averageEv === "number"
          ? (row as { averageEv: number }).averageEv
          : null;

  return {
    id,
    source: "polymarket",
    title: row.title?.trim() || "Polymarket trade",
    outcome: row.outcome?.trim() || "Yes",
    side: row.side === "SELL" ? "SELL" : "BUY",
    price,
    size,
    usdNotional,
    timestamp,
    traceable: Boolean(row.transactionHash?.trim()),
    transactionHash: row.transactionHash?.trim() || undefined,
    slug: row.slug?.trim() || undefined,
    assetId: row.assetId?.trim() || undefined,
    netEvPercent,
    category: category?.trim() || undefined,
  };
}

function filterKalshiEligible(
  candidates: RecentFeedTrade[],
  pipelineEvIndex: Map<string, PipelineTradeEv>
): RecentFeedTrade[] {
  return candidates.flatMap((trade) => {
    const whale = kalshiFeedTradeToWhale(trade, {
      netEvPercent: trade.netEvPercent ?? null,
    });
    if (!isKalshiTradeEligibleForFeed(whale, pipelineEvIndex)) return [];

    const lookupKey = trade.ticker
      ? normalizePipelineLookupKey(`kalshi:${trade.ticker}`, "kalshi")
      : null;
    const pipeline = lookupKey ? pipelineEvIndex.get(lookupKey) : undefined;
    const netEvPercent = resolveFeedTradeEvPercent(
      { price: trade.price, netEvPercent: trade.netEvPercent },
      pipeline
    );

    return [{ ...trade, netEvPercent }];
  });
}

async function qualifyKalshiRecentTrades(
  candidates: RecentFeedTrade[],
  options?: { cacheOnly?: boolean; computeEvLimit?: number }
): Promise<RecentFeedTrade[]> {
  const cacheOnly = options?.cacheOnly ?? true;
  const pipelineEvIndex = await resolveCachedKalshiPipelineEv(candidates);
  let qualified = filterKalshiEligible(candidates, pipelineEvIndex);

  if (cacheOnly || qualified.length >= candidates.length) {
    return qualified;
  }

  const qualifiedIds = new Set(qualified.map((trade) => trade.id));
  const remaining = candidates
    .filter((trade) => !qualifiedIds.has(trade.id))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, options?.computeEvLimit ?? KALSHI_EV_COMPUTE_LIMIT);

  await mapWithConcurrency(remaining, 4, async (trade) => {
    if (!trade.ticker?.trim()) return;
    const ticker = trade.ticker.trim().toUpperCase();
    const lookupKey = normalizePipelineLookupKey(`kalshi:${ticker}`, "kalshi");

    try {
      const pipeline = await ensureFullyComputedTradeEv(
        lookupKey,
        {
          source: "kalshi",
          kalshiTicker: ticker,
          tradePrice: trade.price,
        },
        null
      );
      const key = pipelineEvLookupKey({
        source: "kalshi",
        kalshiTicker: ticker,
        tradePrice: trade.price,
      });
      if (key) pipelineEvIndex.set(key, pipeline);
      pipelineEvIndex.set(lookupKey, pipeline);
    } catch {
      // Skip tickers that cannot be EV-mapped.
    }
  });

  qualified = filterKalshiEligible(candidates, pipelineEvIndex);
  return qualified;
}

function readShadowPayloadNetEvPercent(rawPayload: unknown): number | null {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const value = (rawPayload as { netEvPercent?: unknown }).netEvPercent;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function kalshiShadowToFeedTrade(row: KalshiShadowTrade): RecentFeedTrade | null {
  const raw =
    row.rawPayload && typeof row.rawPayload === "object"
      ? (row.rawPayload as Record<string, unknown>)
      : null;

  const title =
    typeof raw?.title === "string" && raw.title.trim()
      ? raw.title.trim()
      : row.ticker;

  const outcomeFromRaw =
    typeof raw?.outcome === "string" && raw.outcome.trim()
      ? raw.outcome.trim()
      : null;
  const outcome =
    outcomeFromRaw ??
    (row.takerOutcomeSide === "yes" || row.takerSide === "yes" ? "Yes" : "No");

  const side =
    raw?.side === "SELL" || row.takerBookSide === "ask" ? "SELL" : "BUY";

  const timestamp = Math.floor(row.tradedAt.getTime() / 1000);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const usdNotional =
    row.usdNotional != null && Number.isFinite(row.usdNotional)
      ? row.usdNotional
      : row.entryPrice * row.size;
  if (!Number.isFinite(usdNotional) || usdNotional <= 0) return null;

  const netEvPercent = readShadowPayloadNetEvPercent(raw);

  return {
    id: row.tradeId,
    source: "kalshi",
    title,
    outcome,
    side,
    price: row.entryPrice,
    size: row.size,
    usdNotional,
    timestamp,
    traceable: true,
    ticker: row.ticker,
    selectionLabel:
      typeof raw?.selectionLabel === "string"
        ? raw.selectionLabel
        : undefined,
    isBlockTrade: row.isBlockTrade,
    netEvPercent,
    category: row.category?.trim() || undefined,
  };
}

async function resolveCachedKalshiPipelineEv(
  trades: RecentFeedTrade[]
): Promise<Map<string, PipelineTradeEv>> {
  const index = new Map<string, PipelineTradeEv>();
  const byTicker = new Map<string, { ticker: string; price: number }>();

  for (const trade of trades) {
    if (trade.source !== "kalshi" || !trade.ticker?.trim()) continue;
    const ticker = trade.ticker.trim().toUpperCase();
    if (!byTicker.has(ticker)) {
      byTicker.set(ticker, { ticker, price: trade.price });
    }
  }

  await mapWithConcurrency(Array.from(byTicker.values()), 8, async (bucket) => {
    const lookupKey = normalizePipelineLookupKey(
      `kalshi:${bucket.ticker}`,
      "kalshi"
    );
    try {
      const pipeline = await ensureFullyComputedTradeEv(
        lookupKey,
        {
          source: "kalshi",
          kalshiTicker: bucket.ticker,
          tradePrice: bucket.price,
        },
        null,
        { cacheOnly: true }
      );
      const key = pipelineEvLookupKey({
        source: "kalshi",
        kalshiTicker: bucket.ticker,
        tradePrice: bucket.price,
      });
      if (key) index.set(key, pipeline);
      index.set(lookupKey, pipeline);
    } catch {
      // Skip tickers without cached EV.
    }
  });

  return index;
}

async function fetchRecentPolymarketTrades(
  options: RecentFetchOptions = {}
): Promise<RecentFeedTrade[]> {
  const limit = options.limit ?? RECENT_TRADES_LIMIT;
  const categoryFilter = options.categoryFilter ?? "all";
  if (!isDatabaseEnabled()) return [];

  const dbCategory = dbCategoryForFilter(categoryFilter);
  const predicates = [
    gte(feedTrades.stakeAmount, MIN_PRODUCT_FEED_STAKE_USD),
    gte(feedTrades.averageEv, MIN_FEED_TRADE_EV_PCT),
  ];
  if (options.since) predicates.push(gte(feedTrades.tradedAt, options.since));
  if (dbCategory) predicates.push(eq(feedTrades.category, dbCategory));

  try {
    const rows = await getDb()
      .select({
        payload: feedTrades.payload,
        averageEv: feedTrades.averageEv,
        category: feedTrades.category,
      })
      .from(feedTrades)
      .where(and(...predicates))
      .orderBy(desc(feedTrades.tradedAt))
      .limit(limit);

    const trades = rows
      .map((row) =>
        polymarketPayloadToFeedTrade(row.payload, row.averageEv, row.category)
      )
      .filter((trade): trade is RecentFeedTrade => trade != null)
      .filter(
        (trade) => !options.excludeKeys?.has(recentTradeDedupeKey(trade))
      );

    return applyRecentCategoryFilter(trades, categoryFilter);
  } catch (error) {
    console.error(
      "[recentTrades] polymarket read failed",
      error instanceof Error ? error.message : error
    );
    throw new RecentTradesReadError("polymarket", error);
  }
}

function kalshiStoredEvSqlPredicates(): ReturnType<typeof sql>[] {
  return [
    sql`(${kalshiShadowTrades.rawPayload} ->> 'netEvPercent') ~ '^-?[0-9]+(\\.[0-9]+)?$'`,
    sql`(${kalshiShadowTrades.rawPayload} ->> 'netEvPercent')::double precision >= ${MIN_FEED_TRADE_EV_PCT}`,
  ];
}

function kalshiMissingStoredEvSqlPredicate(): ReturnType<typeof sql> {
  return sql`(
    ${kalshiShadowTrades.rawPayload} ->> 'netEvPercent' IS NULL
    OR NOT ((${kalshiShadowTrades.rawPayload} ->> 'netEvPercent') ~ '^-?[0-9]+(\\.[0-9]+)?$')
    OR (${kalshiShadowTrades.rawPayload} ->> 'netEvPercent')::double precision < ${MIN_FEED_TRADE_EV_PCT}
  )`;
}

async function fetchRecentKalshiTrades(
  options: RecentFetchOptions = {}
): Promise<RecentFeedTrade[]> {
  const limit = options.limit ?? RECENT_TRADES_LIMIT;
  const categoryFilter = options.categoryFilter ?? "all";
  if (!isDatabaseEnabled()) return [];

  const dbCategory = dbCategoryForFilter(categoryFilter);
  const basePredicates = [
    gte(kalshiShadowTrades.usdNotional, MIN_PRODUCT_FEED_STAKE_USD),
  ];
  if (options.since) {
    basePredicates.push(gte(kalshiShadowTrades.tradedAt, options.since));
  }
  if (dbCategory) basePredicates.push(eq(kalshiShadowTrades.category, dbCategory));

  try {
    const storedEvRows = await getDb()
      .select()
      .from(kalshiShadowTrades)
      .where(and(...basePredicates, ...kalshiStoredEvSqlPredicates()))
      .orderBy(desc(kalshiShadowTrades.tradedAt))
      .limit(limit);

    let merged = storedEvRows
      .map((row) => kalshiShadowToFeedTrade(row))
      .filter((trade): trade is RecentFeedTrade => trade != null)
      .filter(
        (trade) => !options.excludeKeys?.has(recentTradeDedupeKey(trade))
      );

    if (merged.length < limit) {
      const seenIds = new Set(merged.map((trade) => trade.id));

      const supplementalRows = await getDb()
        .select()
        .from(kalshiShadowTrades)
        .where(and(...basePredicates, kalshiMissingStoredEvSqlPredicate()))
        .orderBy(desc(kalshiShadowTrades.tradedAt))
        .limit(KALSHI_DB_READ_LIMIT);

      const candidates = supplementalRows
        .map((row) => kalshiShadowToFeedTrade(row))
        .filter((trade): trade is RecentFeedTrade => trade != null)
        .filter((trade) => !seenIds.has(trade.id))
        .filter(
          (trade) => !options.excludeKeys?.has(recentTradeDedupeKey(trade))
        );

      const pipelineQualified = await qualifyKalshiRecentTrades(candidates, {
        cacheOnly: true,
      });

      merged = [...merged, ...pipelineQualified]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
    }

    return applyRecentCategoryFilter(merged, categoryFilter);
  } catch (error) {
    console.error(
      "[recentTrades] kalshi read failed",
      error instanceof Error ? error.message : error
    );
    throw new RecentTradesReadError("kalshi", error);
  }
}

/** Latest qualifying feed trades from Postgres — instant page-load hydration. */
export async function fetchRecentFeedTrades(options?: {
  category?: RecentFeedCategoryFilter;
}): Promise<FetchRecentFeedTradesResult> {
  const categoryFilter = options?.category ?? "all";
  if (!isDatabaseEnabled()) return { trades: [], degraded: [] };

  const degraded: string[] = [];
  const oneHourAgo = new Date(Date.now() - RECENT_TRADES_HOUR_MS);

  let pmHour: RecentFeedTrade[] = [];
  let kalshiHour: RecentFeedTrade[] = [];

  try {
    pmHour = await fetchRecentPolymarketTrades({
      since: oneHourAgo,
      limit: RECENT_TRADES_LIMIT,
      categoryFilter,
    });
  } catch (error) {
    degraded.push(
      error instanceof RecentTradesReadError ? error.source : "polymarket"
    );
    console.error(error);
  }

  try {
    kalshiHour = await fetchRecentKalshiTrades({
      since: oneHourAgo,
      limit: RECENT_TRADES_LIMIT,
      categoryFilter,
    });
  } catch (error) {
    degraded.push(
      error instanceof RecentTradesReadError ? error.source : "kalshi"
    );
    console.error(error);
  }

  let results = combineRecentTrades(pmHour, kalshiHour, RECENT_TRADES_LIMIT);

  if (results.length < RECENT_TRADES_LIMIT) {
    const excludeKeys = new Set(results.map(recentTradeDedupeKey));
    const need = RECENT_TRADES_LIMIT - results.length;

    let pmFallback: RecentFeedTrade[] = [];
    let kalshiFallback: RecentFeedTrade[] = [];

    try {
      pmFallback = await fetchRecentPolymarketTrades({
        limit: need + POLYMARKET_FALLBACK_READ_LIMIT,
        excludeKeys,
        categoryFilter,
      });
    } catch (error) {
      if (!degraded.includes("polymarket")) {
        degraded.push(
          error instanceof RecentTradesReadError ? error.source : "polymarket"
        );
      }
      console.error(error);
    }

    try {
      kalshiFallback = await fetchRecentKalshiTrades({
        limit: need,
        excludeKeys,
        categoryFilter,
      });
    } catch (error) {
      if (!degraded.includes("kalshi")) {
        degraded.push(
          error instanceof RecentTradesReadError ? error.source : "kalshi"
        );
      }
      console.error(error);
    }

    results = dedupeRecentTrades([
      ...results,
      ...pmFallback,
      ...kalshiFallback,
    ])
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, RECENT_TRADES_LIMIT);
  }

  return {
    trades: applyRecentCategoryFilter(results, categoryFilter),
    degraded,
  };
}
