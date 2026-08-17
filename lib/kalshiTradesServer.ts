import "server-only";

import { mapWithConcurrency } from "@/lib/clvPriceHistory";
import {
  indexPipelineTradeEvAliases,
  normalizeKalshiTicker,
} from "@/lib/evPipeline/crossAssetLookup";
import { normalizeKalshiOutcomeSide } from "@/lib/evPipeline/kalshiOutcomeEv";
import { ensureFullyComputedTradeEv } from "@/lib/evPipeline/resolveTradeEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  normalizePipelineLookupKey,
  pipelineEvLookupKey,
} from "@/lib/evPipeline/types";
import type { FeedTrade } from "@/lib/feedTradeTypes";
import {
  kalshiFeedTradeToWhale,
  resolveKalshiFeedTradeEvPercent,
} from "@/lib/feed/kalshiFeedTrades";
import {
  meetsProductFeedEvThreshold,
  meetsProductFeedStakeThreshold,
  MIN_PRODUCT_FEED_STAKE_USD,
} from "@/lib/feedQualification";
import { pipelineEvKeyForTrade, resolvePipelineEvFromIndex } from "@/lib/pipelineEvLookupHelpers";
import {
  KALSHI_TRADES_MAX_PAGES_INCREMENTAL,
  KALSHI_TRADES_MAX_PAGES_INITIAL,
  KALSHI_TRADES_PAGE_LIMIT,
  KALSHI_TRADES_POLL_MS,
} from "@/lib/ingestionPollConfig";
import { resolveKalshiMarketsLite } from "@/lib/kalshiTitleResolver";
import { kalshiFetch } from "@/lib/kalshi/http";
import { queueKalshiShadowTrade, serializeShadowPayload } from "@/lib/x-agent/kalshiShadowTrades";
import {
  logKalshiEvCheck,
  logKalshiEvGateDrop,
  logKalshiGatePass,
  logKalshiPollIngested,
  logKalshiShadowQueued,
  logKalshiStakeDrop,
} from "@/lib/feed/kalshiIngestTrace";

export interface KalshiRawTrade {
  trade_id: string;
  ticker: string;
  created_time: string;
  count_fp: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  taker_side: "yes" | "no";
  taker_outcome_side?: "yes" | "no";
  taker_book_side?: "bid" | "ask";
  is_block_trade?: boolean;
}

function shadowInputFromRaw(
  raw: KalshiRawTrade,
  normalized: FeedTrade,
  netEvPercent?: number | null
): Parameters<typeof queueKalshiShadowTrade>[0] {
  const basePayload = serializeShadowPayload(
    raw as unknown as Record<string, unknown>
  );
  return {
    tradeId: raw.trade_id,
    ticker: normalizeKalshiTicker(raw.ticker) ?? raw.ticker.trim().toUpperCase(),
    size: normalized.size,
    timestamp: normalized.timestamp,
    entryPrice: normalized.price,
    takerSide: raw.taker_side,
    takerOutcomeSide: raw.taker_outcome_side ?? null,
    takerBookSide: raw.taker_book_side ?? null,
    isBlockTrade: raw.is_block_trade === true,
    usdNotional: normalized.usdNotional,
    rawPayload: {
      ...(basePayload ?? {}),
      title: normalized.title,
      outcome: normalized.outcome,
      side: normalized.side,
      selectionLabel: normalized.selectionLabel,
      netEvPercent:
        netEvPercent != null && Number.isFinite(netEvPercent)
          ? netEvPercent
          : undefined,
    },
  };
}

const SKEW_TOLERANCE_SEC = 5;

function parseTimestamp(createdTime: string, nowEpochSeconds: number): number {
  const parsed = Math.floor(Date.parse(createdTime) / 1000);
  if (!Number.isFinite(parsed)) return nowEpochSeconds;
  if (parsed > nowEpochSeconds + SKEW_TOLERANCE_SEC) {
    return nowEpochSeconds;
  }
  return parsed;
}

function normalizeKalshiTrade(
  raw: KalshiRawTrade,
  market: { eventTitle: string; selectionLabel?: string | null },
  nowEpochSeconds: number
): FeedTrade | null {
  const price =
    raw.taker_side === "yes"
      ? parseFloat(raw.yes_price_dollars)
      : parseFloat(raw.no_price_dollars);
  const size = parseFloat(raw.count_fp);

  if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) {
    return null;
  }

  const usdNotional = price * size;
  if (!Number.isFinite(usdNotional) || usdNotional <= 0) return null;

  const outcome =
    (raw.taker_outcome_side ?? raw.taker_side) === "yes" ? "Yes" : "No";

  return {
    id: raw.trade_id,
    source: "kalshi",
    title: market.eventTitle,
    outcome,
    side: raw.taker_book_side === "ask" ? "SELL" : "BUY",
    price,
    size,
    usdNotional,
    timestamp: parseTimestamp(raw.created_time, nowEpochSeconds),
    traceable: true,
    ticker: normalizeKalshiTicker(raw.ticker) ?? raw.ticker.trim().toUpperCase(),
    selectionLabel: market.selectionLabel ?? undefined,
    isBlockTrade: raw.is_block_trade === true,
  };
}

function logKalshiPipelineIngest(
  trade: Pick<FeedTrade, "ticker" | "usdNotional">,
  pipeline: PipelineTradeEv | null,
  calculatedEv: number | null,
  passedGate: boolean,
  dynamicCompute = false
): void {
  console.log("[Kalshi Pipeline]", {
    ticker: trade.ticker,
    stake: trade.usdNotional,
    evStatus: pipeline?.status ?? "missing",
    calculatedEv: pipeline?.netEvPercent ?? null,
    resolvedEv: calculatedEv,
    passedGate,
    dynamicCompute,
  });
}

function kalshiPipelineInputFromTrade(
  trade: Pick<FeedTrade, "ticker" | "price" | "title" | "outcome">
): {
  source: "kalshi";
  kalshiTicker: string;
  tradePrice: number;
  title: string;
  kalshiOutcomeSide: "yes" | "no";
} {
  const normalizedTicker =
    normalizeKalshiTicker(trade.ticker) ?? trade.ticker!.trim().toUpperCase();
  return {
    source: "kalshi",
    kalshiTicker: normalizedTicker,
    tradePrice: trade.price,
    title: trade.title?.trim() || normalizedTicker,
    kalshiOutcomeSide: normalizeKalshiOutcomeSide(trade.outcome),
  };
}

function kalshiProbeTrade(ticker: string, price: number): FeedTrade {
  return {
    id: `probe:${ticker}`,
    source: "kalshi",
    title: ticker,
    outcome: "Yes",
    side: "BUY",
    price,
    size: 1,
    usdNotional: MIN_PRODUCT_FEED_STAKE_USD,
    timestamp: Math.floor(Date.now() / 1000),
    traceable: false,
    ticker,
  };
}

async function ensureKalshiTickerPipelineEv(
  trade: Pick<FeedTrade, "ticker" | "price" | "title" | "outcome">,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  options?: { preferDynamicCompute?: boolean; cacheOnly?: boolean }
): Promise<PipelineTradeEv> {
  const normalizedTicker =
    normalizeKalshiTicker(trade.ticker) ?? trade.ticker!.trim().toUpperCase();
  const lookupKey = normalizePipelineLookupKey(
    `kalshi:${normalizedTicker}`,
    "kalshi"
  );
  const input = kalshiPipelineInputFromTrade(trade);
  const key = pipelineEvLookupKey(input) ?? lookupKey;

  const applyPipeline = (pipeline: PipelineTradeEv) => {
    indexPipelineTradeEvAliases(pipelineEvIndex, pipeline, key);
    return pipeline;
  };

  const resolveProbeEv = () => {
    const probe = kalshiProbeTrade(normalizedTicker, trade.price);
    return kalshiTradeEvPercent(probe, pipelineEvIndex);
  };

  if (options?.preferDynamicCompute) {
    const pipeline = applyPipeline(
      await ensureFullyComputedTradeEv(lookupKey, input, null, {
        kalshiObOnly: true,
      })
    );
    const resolvedEv = resolveProbeEv();
    logKalshiPipelineIngest(
      { ticker: normalizedTicker, usdNotional: MIN_PRODUCT_FEED_STAKE_USD },
      pipeline,
      resolvedEv,
      meetsProductFeedEvThreshold(resolvedEv),
      true
    );
    return pipeline;
  }

  let pipeline = applyPipeline(
    await ensureFullyComputedTradeEv(lookupKey, input, null, { cacheOnly: true })
  );

  let resolvedEv = resolveProbeEv();
  logKalshiPipelineIngest(
    { ticker: normalizedTicker, usdNotional: MIN_PRODUCT_FEED_STAKE_USD },
    pipeline,
    resolvedEv,
    meetsProductFeedEvThreshold(resolvedEv)
  );

  if (!meetsProductFeedEvThreshold(resolvedEv) && !options?.cacheOnly) {
    pipeline = applyPipeline(
      await ensureFullyComputedTradeEv(lookupKey, input, null, {
        kalshiObOnly: true,
      })
    );
    resolvedEv = resolveProbeEv();
    logKalshiPipelineIngest(
      { ticker: normalizedTicker, usdNotional: MIN_PRODUCT_FEED_STAKE_USD },
      pipeline,
      resolvedEv,
      meetsProductFeedEvThreshold(resolvedEv),
      true
    );
  }

  return pipeline;
}

/** Build a Kalshi pipeline EV index — cache-first, then dynamic compute on miss. */
export async function resolveCachedKalshiPipelineEv(
  trades: Array<Pick<FeedTrade, "ticker" | "price" | "title" | "outcome">>,
  options?: { cacheOnly?: boolean }
): Promise<Map<string, PipelineTradeEv>> {
  const index = new Map<string, PipelineTradeEv>();
  const byTicker = new Map<
    string,
    Pick<FeedTrade, "ticker" | "price" | "title" | "outcome">
  >();

  for (const trade of trades) {
    if (!trade.ticker?.trim()) continue;
    const ticker =
      normalizeKalshiTicker(trade.ticker) ?? trade.ticker.trim().toUpperCase();
    if (!byTicker.has(ticker)) {
      byTicker.set(ticker, { ...trade, ticker });
    }
  }

  await mapWithConcurrency(Array.from(byTicker.values()), 4, async (bucket) => {
    try {
      await ensureKalshiTickerPipelineEv(bucket, index, {
        cacheOnly: options?.cacheOnly === true,
      });
    } catch (error) {
      console.warn(
        "[Kalshi Pipeline] ticker EV resolve failed",
        bucket.ticker,
        error instanceof Error ? error.message : error
      );
    }
  });

  return index;
}

function resolveKalshiPipelineFromIndex(
  trade: FeedTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): PipelineTradeEv | null {
  const key = pipelineEvKeyForTrade(trade);
  return resolvePipelineEvFromIndex(pipelineEvIndex, key, {
    kalshiTicker: trade.ticker ?? null,
  });
}

function kalshiTradeEvPercent(
  trade: FeedTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): number | null {
  if (!trade.ticker?.trim()) return null;
  const pipeline = resolveKalshiPipelineFromIndex(trade, pipelineEvIndex);
  const whale = kalshiFeedTradeToWhale({
    id: trade.id,
    title: trade.title,
    outcome: trade.outcome,
    side: trade.side,
    price: trade.price,
    usdNotional: trade.usdNotional,
    timestamp: trade.timestamp,
    ticker: trade.ticker,
    selectionLabel: trade.selectionLabel,
    category: trade.category,
  });
  return resolveKalshiFeedTradeEvPercent(whale, pipeline ?? null);
}

export async function hydrateKalshiTradeEvPercent(
  trade: FeedTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): Promise<number | null> {
  const cached = kalshiTradeEvPercent(trade, pipelineEvIndex);
  if (meetsProductFeedEvThreshold(cached)) {
    logKalshiPipelineIngest(
      trade,
      resolveKalshiPipelineFromIndex(trade, pipelineEvIndex),
      cached,
      true
    );
    return cached;
  }

  if (!trade.ticker?.trim()) return cached;

  try {
    await ensureKalshiTickerPipelineEv(trade, pipelineEvIndex, {
      preferDynamicCompute: meetsProductFeedStakeThreshold(trade.usdNotional),
    });
  } catch {
    return cached;
  }

  const resolved = kalshiTradeEvPercent(trade, pipelineEvIndex);
  logKalshiPipelineIngest(
    trade,
    resolveKalshiPipelineFromIndex(trade, pipelineEvIndex),
    resolved,
    meetsProductFeedEvThreshold(resolved),
    true
  );
  return resolved;
}

const KALSHI_TRADES_PAGE_SIZE = KALSHI_TRADES_PAGE_LIMIT;

type KalshiUpstreamCache = {
  fetchedAt: number;
  trades: FeedTrade[];
  inFlight: Promise<FeedTrade[]> | null;
};

const kalshiUpstreamCache: KalshiUpstreamCache = {
  fetchedAt: 0,
  trades: [],
  inFlight: null,
};

function filterKalshiTradesByMinTs(
  trades: FeedTrade[],
  minTs?: number
): FeedTrade[] {
  if (minTs == null || !Number.isFinite(minTs) || minTs <= 0) return trades;
  return trades.filter((trade) => trade.timestamp > minTs);
}

async function fetchKalshiTradesFromApi(
  minTs?: number
): Promise<FeedTrade[]> {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  const raws: KalshiRawTrade[] = [];
  let cursor: string | undefined;
  const maxPages =
    minTs != null && minTs > 0
      ? KALSHI_TRADES_MAX_PAGES_INCREMENTAL
      : KALSHI_TRADES_MAX_PAGES_INITIAL;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      limit: String(KALSHI_TRADES_PAGE_SIZE),
    });
    if (minTs != null && minTs > 0) {
      params.set("min_ts", String(minTs));
    }
    if (cursor) params.set("cursor", cursor);

    const res = await kalshiFetch(`/markets/trades?${params}`, {
      next: { revalidate: 0 },
      label: "markets/trades",
    });

    if (!res.ok) {
      if (raws.length > 0) break;
      throw new Error(
        `Kalshi trades API error: ${res.status} ${res.statusText}`
      );
    }

    const data = (await res.json()) as {
      trades?: KalshiRawTrade[];
      cursor?: string;
    };
    if (!Array.isArray(data?.trades) || data.trades.length === 0) break;

    raws.push(...data.trades);
    cursor = data.cursor?.trim() || undefined;
    if (!cursor) break;
  }

  if (raws.length === 0) return [];

  logKalshiPollIngested(raws.length);
  console.log(
    `[kalshi/trades] fetched=${raws.length} pages<=${maxPages} limit=${KALSHI_TRADES_PAGE_SIZE}`
  );

  const uniqueTickers = Array.from(
    new Set(raws.map((raw) => raw.ticker).filter(Boolean))
  );
  const marketCache = await resolveKalshiMarketsLite(uniqueTickers);
  const trades: FeedTrade[] = [];
  const shadowCandidates: Array<{
    raw: KalshiRawTrade;
    normalized: FeedTrade;
  }> = [];

  for (const raw of raws) {
    if (!raw?.trade_id || !raw?.ticker) continue;

    const cached = marketCache.get(raw.ticker);
    const market = cached ?? {
      eventTitle: raw.ticker,
      selectionLabel: null,
    };

    const normalized = normalizeKalshiTrade(raw, market, nowEpochSeconds);
    if (!normalized) continue;

    trades.push(normalized);

    if (meetsProductFeedStakeThreshold(normalized.usdNotional)) {
      shadowCandidates.push({ raw, normalized });
    } else {
      logKalshiStakeDrop(normalized);
    }
  }

  console.log(
    `[kalshi/trades] raw=${raws.length} normalized=${trades.length} stakeCandidates=${shadowCandidates.length}`
  );

  let evQualified = 0;
  let shadowQueued = 0;
  const stakeQualified = trades.filter((trade) =>
    meetsProductFeedStakeThreshold(trade.usdNotional)
  );
  const pipelineEvIndex =
    stakeQualified.length > 0
      ? await resolveCachedKalshiPipelineEv(stakeQualified)
      : new Map<string, PipelineTradeEv>();

  if (shadowCandidates.length > 0) {
    const { categorizeMarket } = await import("@/lib/categorizer");

    for (const { raw, normalized } of shadowCandidates) {
      const tradeEvPercent = await hydrateKalshiTradeEvPercent(
        normalized,
        pipelineEvIndex
      );
      const resolvedPipeline = resolveKalshiPipelineFromIndex(
        normalized,
        pipelineEvIndex
      );
      logKalshiEvCheck(normalized, resolvedPipeline, tradeEvPercent);

      const category = await categorizeMarket(normalized.title, normalized.ticker, {
        backfillDb: true,
        marketKey: normalized.ticker,
      });

      queueKalshiShadowTrade({
        ...shadowInputFromRaw(raw, normalized, tradeEvPercent),
        category,
      });
      shadowQueued += 1;
      logKalshiShadowQueued(normalized, tradeEvPercent);

      if (!meetsProductFeedEvThreshold(tradeEvPercent)) {
        logKalshiEvGateDrop(normalized, tradeEvPercent);
        continue;
      }

      evQualified += 1;
      logKalshiGatePass(normalized, tradeEvPercent as number);
    }
  }

  if (shadowCandidates.length > 0) {
    console.log(
      `[kalshi/trades] evQualified=${evQualified} shadowQueued=${shadowQueued}`
    );
  }

  const stakeQualifiedWithEv = await mapWithConcurrency(
    stakeQualified,
    4,
    async (trade) => {
      const netEvPercent = await hydrateKalshiTradeEvPercent(
        trade,
        pipelineEvIndex
      );
      const resolvedPipeline = resolveKalshiPipelineFromIndex(
        trade,
        pipelineEvIndex
      );
      logKalshiEvCheck(trade, resolvedPipeline, netEvPercent);
      if (meetsProductFeedEvThreshold(netEvPercent)) {
        logKalshiGatePass(trade, netEvPercent as number);
      } else {
        logKalshiEvGateDrop(trade, netEvPercent);
      }
      return {
        ...trade,
        netEvPercent:
          netEvPercent != null && Number.isFinite(netEvPercent)
            ? netEvPercent
            : trade.netEvPercent,
      };
    }
  );

  const stakeQualifiedIds = new Set(stakeQualifiedWithEv.map((trade) => trade.id));
  const belowStake = trades.filter(
    (trade) => !stakeQualifiedIds.has(trade.id)
  );

  return [...stakeQualifiedWithEv, ...belowStake];
}

/**
 * Kalshi trades with upstream throttling — at most one REST sweep per
 * {@link KALSHI_TRADES_POLL_MS}. Serves cached rows filtered by `min_ts`.
 */
export async function fetchKalshiTrades(
  minTs?: number,
  options?: { bypassThrottle?: boolean }
): Promise<FeedTrade[]> {
  const now = Date.now();
  const cacheAge = now - kalshiUpstreamCache.fetchedAt;
  const cacheFresh =
    kalshiUpstreamCache.fetchedAt > 0 && cacheAge < KALSHI_TRADES_POLL_MS;

  if (!options?.bypassThrottle && cacheFresh) {
    return filterKalshiTradesByMinTs(kalshiUpstreamCache.trades, minTs);
  }

  if (!options?.bypassThrottle && kalshiUpstreamCache.inFlight) {
    const trades = await kalshiUpstreamCache.inFlight;
    return filterKalshiTradesByMinTs(trades, minTs);
  }

  const run = fetchKalshiTradesFromApi(minTs).then((trades) => {
    kalshiUpstreamCache.trades = trades;
    kalshiUpstreamCache.fetchedAt = Date.now();
    kalshiUpstreamCache.inFlight = null;
    return trades;
  });

  if (!options?.bypassThrottle) {
    kalshiUpstreamCache.inFlight = run;
  }

  const trades = await run;
  return filterKalshiTradesByMinTs(trades, minTs);
}
