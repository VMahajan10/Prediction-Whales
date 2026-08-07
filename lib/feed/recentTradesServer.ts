import "server-only";

import { and, desc, gte } from "drizzle-orm";
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
import { collectKalshiFeedCandidates } from "@/lib/feed/kalshiFeedCandidatesServer";
import {
  filterQualifiedPolymarketFeedTrades,
} from "@/lib/feedQualificationServer";
import {
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
import { fetchWhaleBackfill, type TradeSummary } from "@/lib/polymarket";

initGlobalLocalEvCache();

export const RECENT_TRADES_LIMIT = 20;

/** Max Kalshi rows to fully EV-compute when cache is cold. */
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
  averageEv?: number
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
  };
}

function tradeSummaryToRecentFeedTrade(
  trade: TradeSummary,
  netEvPercent: number
): RecentFeedTrade | null {
  const usdNotional = resolvePolymarketTradeNotionalUsd(trade);
  if (usdNotional <= 0) return null;

  return {
    id: trade.id,
    source: "polymarket",
    title: trade.title,
    outcome: trade.outcome,
    side: trade.side,
    price: trade.price,
    size: trade.size,
    usdNotional,
    timestamp: trade.timestamp,
    traceable: Boolean(trade.transactionHash?.trim()),
    transactionHash: trade.transactionHash?.trim() || undefined,
    slug: trade.slug,
    assetId: trade.assetId,
    netEvPercent,
  };
}

function feedTradeToRecentFeedTrade(trade: FeedTrade): RecentFeedTrade {
  return {
    id: trade.id,
    source: "kalshi",
    title: trade.title,
    outcome: trade.outcome,
    side: trade.side,
    price: trade.price,
    size: trade.size,
    usdNotional: trade.usdNotional,
    timestamp: trade.timestamp,
    traceable: trade.traceable,
    ticker: trade.ticker,
    selectionLabel: trade.selectionLabel,
    isBlockTrade: trade.isBlockTrade,
  };
}

function tradeDedupeKey(trade: RecentFeedTrade): string {
  return `${trade.source}:${trade.id}`;
}

function mergeRecentTrades(
  polymarket: RecentFeedTrade[],
  kalshi: RecentFeedTrade[]
): RecentFeedTrade[] {
  return [...polymarket, ...kalshi]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, RECENT_TRADES_LIMIT);
}

function dedupeMergeRecentTrades(
  existing: RecentFeedTrade[],
  supplemental: RecentFeedTrade[]
): RecentFeedTrade[] {
  const seen = new Set(existing.map(tradeDedupeKey));
  const merged = [...existing];

  for (const trade of supplemental.sort((a, b) => b.timestamp - a.timestamp)) {
    const key = tradeDedupeKey(trade);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trade);
  }

  return merged
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, RECENT_TRADES_LIMIT);
}

function filterKalshiEligible(
  candidates: RecentFeedTrade[],
  pipelineEvIndex: Map<string, PipelineTradeEv>
): RecentFeedTrade[] {
  return candidates.flatMap((trade) => {
    const whale = kalshiFeedTradeToWhale(trade);
    if (!isKalshiTradeEligibleForFeed(whale, pipelineEvIndex)) return [];

    const lookupKey = trade.ticker
      ? normalizePipelineLookupKey(`kalshi:${trade.ticker}`, "kalshi")
      : null;
    const pipeline = lookupKey ? pipelineEvIndex.get(lookupKey) : undefined;
    const netEvPercent = resolveFeedTradeEvPercent(
      { price: trade.price },
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
  limit = RECENT_TRADES_LIMIT
): Promise<RecentFeedTrade[]> {
  if (!isDatabaseEnabled()) return [];

  try {
    const rows = await getDb()
      .select({
        payload: feedTrades.payload,
        averageEv: feedTrades.averageEv,
      })
      .from(feedTrades)
      .where(
        and(
          gte(feedTrades.stakeAmount, MIN_PRODUCT_FEED_STAKE_USD),
          gte(feedTrades.averageEv, MIN_FEED_TRADE_EV_PCT)
        )
      )
      .orderBy(desc(feedTrades.tradedAt))
      .limit(limit);

    return rows
      .map((row) => polymarketPayloadToFeedTrade(row.payload, row.averageEv))
      .filter((trade): trade is RecentFeedTrade => trade != null);
  } catch (error) {
    console.error(
      "[recentTrades] polymarket read failed",
      error instanceof Error ? error.message : error
    );
    return [];
  }
}

async function fetchRecentKalshiTrades(
  limit = RECENT_TRADES_LIMIT
): Promise<RecentFeedTrade[]> {
  if (!isDatabaseEnabled()) return [];

  try {
    const rows = await getDb()
      .select()
      .from(kalshiShadowTrades)
      .where(gte(kalshiShadowTrades.usdNotional, MIN_PRODUCT_FEED_STAKE_USD))
      .orderBy(desc(kalshiShadowTrades.tradedAt))
      .limit(limit);

    const candidates = rows
      .map((row) => kalshiShadowToFeedTrade(row))
      .filter((trade): trade is RecentFeedTrade => trade != null);

    return await qualifyKalshiRecentTrades(candidates, {
      cacheOnly: false,
      computeEvLimit: KALSHI_EV_COMPUTE_LIMIT,
    });
  } catch (error) {
    console.error(
      "[recentTrades] kalshi read failed",
      error instanceof Error ? error.message : error
    );
    return [];
  }
}

async function fetchSupplementalPolymarketFromApi(
  excludeKeys: Set<string>
): Promise<RecentFeedTrade[]> {
  try {
    const raw = await fetchWhaleBackfill();
    const qualified = await filterQualifiedPolymarketFeedTrades(raw);

    return qualified
      .filter((trade) => !excludeKeys.has(`polymarket:${trade.id}`))
      .map((trade) => tradeSummaryToRecentFeedTrade(trade, trade.netEvPercent))
      .filter((trade): trade is RecentFeedTrade => trade != null);
  } catch (error) {
    console.error(
      "[recentTrades] polymarket API supplemental failed",
      error instanceof Error ? error.message : error
    );
    return [];
  }
}

async function fetchSupplementalKalshiFromApi(
  excludeKeys: Set<string>
): Promise<RecentFeedTrade[]> {
  try {
    const candidates = collectKalshiFeedCandidates()
      .then((trades) =>
        trades
          .filter((trade) => !excludeKeys.has(`kalshi:${trade.id}`))
          .map(feedTradeToRecentFeedTrade)
      );

    const recentTrades = await candidates;
    return await qualifyKalshiRecentTrades(recentTrades, {
      cacheOnly: false,
      computeEvLimit: KALSHI_EV_COMPUTE_LIMIT,
    });
  } catch (error) {
    console.error(
      "[recentTrades] kalshi API supplemental failed",
      error instanceof Error ? error.message : error
    );
    return [];
  }
}

/** Latest qualifying feed trades from Postgres — instant page-load hydration. */
export async function fetchRecentFeedTrades(): Promise<RecentFeedTrade[]> {
  const [polymarket, kalshi] = await Promise.all([
    fetchRecentPolymarketTrades(RECENT_TRADES_LIMIT),
    fetchRecentKalshiTrades(RECENT_TRADES_LIMIT),
  ]);

  let merged = mergeRecentTrades(polymarket, kalshi);

  if (merged.length >= RECENT_TRADES_LIMIT) {
    return merged;
  }

  const excludeKeys = new Set(merged.map(tradeDedupeKey));
  const [apiPolymarket, apiKalshi] = await Promise.all([
    fetchSupplementalPolymarketFromApi(excludeKeys),
    fetchSupplementalKalshiFromApi(excludeKeys),
  ]);

  merged = dedupeMergeRecentTrades(
    merged,
    mergeRecentTrades(apiPolymarket, apiKalshi)
  );

  return merged;
}
