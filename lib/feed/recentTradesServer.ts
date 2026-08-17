import "server-only";

import { and, desc, gte, sql } from "drizzle-orm";
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
  resolveKalshiFeedTradeEvPercent,
} from "@/lib/feed/kalshiFeedTrades";
import { resolveCachedKalshiPipelineEv, hydrateKalshiTradeEvPercent } from "@/lib/kalshiTradesServer";
import { pipelineEvKeyForTrade, resolvePipelineEvFromIndex } from "@/lib/pipelineEvLookupHelpers";
import { normalizeKalshiTicker } from "@/lib/evPipeline/crossAssetLookup";
import {
  meetsProductFeedEvThreshold,
  meetsProductFeedStakeThreshold,
  MIN_FEED_TRADE_EV_PCT,
  MIN_PRODUCT_FEED_STAKE_USD,
  passesPolymarketFeedTraderGate,
  resolvePolymarketTradeNotionalUsd,
  type WalletFeedQualificationInput,
} from "@/lib/feedQualification";
import {
  enrichTradesWithWhaleAlias,
} from "@/lib/trades/getTrades";
import { qualifyWalletsForFeed } from "@/lib/feedQualificationServer";
import { extractTraderWalletAddress } from "@/lib/whaleIdentityResolver";
import { initGlobalLocalEvCache } from "@/lib/evPipeline/redisCache";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import type { FeedTrade } from "@/lib/feedTradeTypes";
import {
  isTrendingByStakeAndRecency,
  tradeCategoryForTab,
  type MarketFeedCategory,
  type RecentFeedCategoryFilter,
} from "@/lib/constants/categories";

initGlobalLocalEvCache();

export const RECENT_TRADES_LIMIT = 50;
/** Balanced per-venue hydration — always fetch without a time window. */
const VENUE_HYDRATION_LIMIT = 25;
/** Hard cap so page-load hydration never blocks on live EV / LLM work. */
const RECENT_FEED_FETCH_TIMEOUT_MS = 12_000;

async function withRecentFeedTimeout<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${label} timed out after ${RECENT_FEED_FETCH_TIMEOUT_MS}ms`
            )
          );
        }, RECENT_FEED_FETCH_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.warn(
      `[recentTrades] ${label} failed`,
      error instanceof Error ? error.message : error
    );
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  trades: NormalizedRecentFeedTrade[];
  degraded: string[];
};

export type NormalizedRecentFeedTrade = RecentFeedTrade & {
  venue: "POLYMARKET" | "KALSHI";
  stake_notional: number;
  /** Decimal EV (+3.0% → 0.03). */
  ev: number | null;
  traded_at: string;
};

function evPercentToDecimal(evPercent: number | null | undefined): number | null {
  if (evPercent == null || !Number.isFinite(evPercent)) return null;
  return evPercent / 100;
}

export function normalizeRecentFeedTrade(
  trade: RecentFeedTrade
): NormalizedRecentFeedTrade {
  const venue = trade.source === "kalshi" ? "KALSHI" : "POLYMARKET";
  return {
    ...trade,
    venue,
    stake_notional: trade.usdNotional,
    ev: evPercentToDecimal(trade.netEvPercent),
    traded_at: new Date(trade.timestamp * 1000).toISOString(),
  };
}

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

function categoryFromPayload(payload: unknown): string | null | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const category = (payload as { category?: unknown }).category;
  return typeof category === "string" && category.trim()
    ? category.trim()
    : undefined;
}

function isPostgresSchemaDriftError(error: unknown): boolean {
  const code =
    (error as { cause?: { code?: string } })?.cause?.code ??
    (error as { code?: string })?.code;
  return code === "42703" || code === "42P01";
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
  proxyWallet?: string;
  wallet?: string;
  address?: string;
  user?: string;
  maker_address?: string;
  taker_address?: string;
  makerAddress?: string;
  takerAddress?: string;
  username?: string;
  name?: string;
  pseudonym?: string;
};

function resolvePayloadProxyWallet(
  row: PolymarketPayload,
  columnProxyWallet?: string | null
): string | undefined {
  const fromColumn = columnProxyWallet?.trim();
  if (fromColumn) return fromColumn;

  return (
    extractTraderWalletAddress({
      proxyWallet: row.proxyWallet,
      wallet: row.wallet,
      address: row.address,
      user: row.user,
      maker_address: row.maker_address,
      taker_address: row.taker_address,
      makerAddress: row.makerAddress,
      takerAddress: row.takerAddress,
    }) ?? undefined
  );
}

function polymarketPayloadToFeedTrade(
  payload: unknown,
  averageEv?: number,
  category?: string | null,
  proxyWallet?: string | null
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
  if (!meetsProductFeedStakeThreshold(usdNotional)) return null;

  const netEvPercent =
    averageEv != null && Number.isFinite(averageEv)
      ? averageEv
      : typeof (row as { netEvPercent?: number }).netEvPercent === "number"
        ? (row as { netEvPercent: number }).netEvPercent
        : typeof (row as { averageEv?: number }).averageEv === "number"
          ? (row as { averageEv: number }).averageEv
          : null;

  const resolvedProxyWallet = resolvePayloadProxyWallet(row, proxyWallet);

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
    proxyWallet: resolvedProxyWallet || undefined,
    netEvPercent,
    category: category?.trim() || undefined,
  };
}

function filterKalshiEligible(
  candidates: RecentFeedTrade[],
  pipelineEvIndex: Map<string, PipelineTradeEv>
): RecentFeedTrade[] {
  return candidates.flatMap((trade) => {
    if (
      meetsProductFeedStakeThreshold(trade.usdNotional) &&
      meetsProductFeedEvThreshold(trade.netEvPercent)
    ) {
      return [trade];
    }

    const whale = kalshiFeedTradeToWhale(trade, {
      netEvPercent: trade.netEvPercent ?? null,
    });
    if (!isKalshiTradeEligibleForFeed(whale, pipelineEvIndex)) return [];

    const lookupKey = pipelineEvKeyForTrade(trade);
    const pipeline = lookupKey
      ? resolvePipelineEvFromIndex(pipelineEvIndex, lookupKey, {
          kalshiTicker: normalizeKalshiTicker(trade.ticker) ?? trade.ticker ?? null,
        })
      : undefined;
    const netEvPercent = resolveKalshiFeedTradeEvPercent(
      whale,
      pipeline ?? null
    );

    return [{ ...trade, netEvPercent }];
  });
}

async function qualifyKalshiRecentTrades(
  candidates: RecentFeedTrade[],
  options?: { cacheOnly?: boolean; computeEvLimit?: number }
): Promise<RecentFeedTrade[]> {
  const cacheOnly = options?.cacheOnly ?? false;
  const pipelineEvIndex = await resolveCachedKalshiPipelineEv(candidates, {
    cacheOnly,
  });
  let qualified = filterKalshiEligible(candidates, pipelineEvIndex);

  if (cacheOnly || qualified.length >= candidates.length) {
    return qualified;
  }

  const qualifiedIds = new Set(qualified.map((trade) => trade.id));
  const remaining = candidates
    .filter((trade) => !qualifiedIds.has(trade.id))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, options?.computeEvLimit ?? KALSHI_EV_COMPUTE_LIMIT);

  await withRecentFeedTimeout(
    "kalshi supplemental EV hydration",
    async () => {
      await mapWithConcurrency(remaining, 4, async (trade) => {
        if (!trade.ticker?.trim()) return;
        await hydrateKalshiTradeEvPercent(trade, pipelineEvIndex);
      });
    },
    undefined
  );

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
    ticker: normalizeKalshiTicker(row.ticker) ?? row.ticker,
    selectionLabel:
      typeof raw?.selectionLabel === "string"
        ? raw.selectionLabel
        : undefined,
    isBlockTrade: row.isBlockTrade,
    netEvPercent,
    category:
      row.category?.trim() ||
      categoryFromPayload(raw) ||
      undefined,
  };
}

function filterRecentPolymarketByTraderCredibility(
  trades: RecentFeedTrade[],
  qualifications: Record<string, WalletFeedQualificationInput>
): RecentFeedTrade[] {
  return trades.filter((trade) => {
    const wallet = trade.proxyWallet?.trim().toLowerCase();
    const qualification = wallet ? qualifications[wallet] : undefined;
    return passesPolymarketFeedTraderGate(wallet, qualification, true);
  });
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

  try {
    const rows = await getDb()
      .select({
        payload: feedTrades.payload,
        averageEv: feedTrades.averageEv,
        proxyWallet: feedTrades.proxyWallet,
      })
      .from(feedTrades)
      .where(and(...predicates))
      .orderBy(desc(feedTrades.tradedAt))
      .limit(limit);

    const trades = rows
      .map((row) =>
        polymarketPayloadToFeedTrade(
          row.payload,
          row.averageEv,
          categoryFromPayload(row.payload),
          row.proxyWallet
        )
      )
      .filter((trade): trade is RecentFeedTrade => trade != null)
      .filter(
        (trade) => !options.excludeKeys?.has(recentTradeDedupeKey(trade))
      );

    const wallets = trades
      .map((trade) => trade.proxyWallet?.trim().toLowerCase())
      .filter((wallet): wallet is string => Boolean(wallet));
    const qualifications = await qualifyWalletsForFeed(wallets);
    const credible = filterRecentPolymarketByTraderCredibility(
      trades,
      qualifications
    );

    return applyRecentCategoryFilter(credible, categoryFilter);
  } catch (error) {
    if (isPostgresSchemaDriftError(error)) {
      console.warn(
        "[recentTrades] polymarket schema drift — skipping DB hydration",
        error instanceof Error ? error.message : error
      );
      return [];
    }
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

  const basePredicates = [
    gte(kalshiShadowTrades.usdNotional, MIN_PRODUCT_FEED_STAKE_USD),
  ];
  if (options.since) {
    basePredicates.push(gte(kalshiShadowTrades.tradedAt, options.since));
  }

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
    if (isPostgresSchemaDriftError(error)) {
      console.warn(
        "[recentTrades] kalshi schema drift — skipping DB hydration",
        error instanceof Error ? error.message : error
      );
      return [];
    }
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

  return withRecentFeedTimeout(
    "fetchRecentFeedTrades",
    async () => fetchRecentFeedTradesInner(categoryFilter),
    { trades: [], degraded: ["polymarket", "kalshi"] }
  );
}

async function fetchRecentFeedTradesInner(
  categoryFilter: RecentFeedCategoryFilter
): Promise<FetchRecentFeedTradesResult> {
  const degraded: string[] = [];
  const [pmResult, kalshiResult] = await Promise.all([
    fetchRecentPolymarketTrades({
      limit: VENUE_HYDRATION_LIMIT,
      categoryFilter,
    }).then(
      (trades) => ({ ok: true as const, trades }),
      (error) => ({ ok: false as const, error })
    ),
    fetchRecentKalshiTrades({
      limit: VENUE_HYDRATION_LIMIT,
      categoryFilter,
    }).then(
      (trades) => ({ ok: true as const, trades }),
      (error) => ({ ok: false as const, error })
    ),
  ]);

  let polymarket: RecentFeedTrade[] = [];
  let kalshi: RecentFeedTrade[] = [];

  if (pmResult.ok) {
    polymarket = pmResult.trades;
    if (polymarket.length === 0) {
      console.warn(
        "[recentTrades] Polymarket query returned 0 qualifying trades — check feed_trades ingestion/schema"
      );
    }
  } else {
    degraded.push(
      pmResult.error instanceof RecentTradesReadError
        ? pmResult.error.source
        : "polymarket"
    );
    console.error(pmResult.error);
  }

  if (kalshiResult.ok) {
    kalshi = kalshiResult.trades;
    if (kalshi.length === 0) {
      console.warn(
        "[recentTrades] Kalshi query returned 0 qualifying trades — check kalshi_shadow_trades ingestion/schema"
      );
    }
  } else {
    degraded.push(
      kalshiResult.error instanceof RecentTradesReadError
        ? kalshiResult.error.source
        : "kalshi"
    );
    console.error(kalshiResult.error);
  }

  const results = combineRecentTrades(polymarket, kalshi, RECENT_TRADES_LIMIT);

  const filtered = applyRecentCategoryFilter(results, categoryFilter).map(
    normalizeRecentFeedTrade
  );

  let enriched: NormalizedRecentFeedTrade[];
  try {
    enriched = await enrichTradesWithWhaleAlias(filtered);
  } catch (error) {
    console.warn(
      "[recentTrades] whale alias enrichment failed",
      error instanceof Error ? error.message : error
    );
    enriched = filtered;
  }

  const qualified = enriched.filter((trade) =>
    meetsProductFeedEvThreshold(trade.netEvPercent)
  );

  return {
    trades: qualified,
    degraded,
  };
}
