import "server-only";

import { mapWithConcurrency } from "@/lib/clvPriceHistory";
import { ensureFullyComputedTradeEv } from "@/lib/evPipeline/resolveTradeEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  normalizePipelineLookupKey,
  pipelineEvLookupKey,
} from "@/lib/evPipeline/types";
import type { FeedTrade } from "@/lib/feedTradeTypes";
import {
  meetsFeedTradeEvThreshold,
  meetsProductFeedStakeThreshold,
} from "@/lib/feedQualification";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import { resolveKalshiMarkets } from "@/lib/kalshiTitleResolver";
import { kalshiFetch } from "@/lib/kalshi/http";
import { queueKalshiShadowTrade, serializeShadowPayload } from "@/lib/x-agent/kalshiShadowTrades";

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
    ticker: raw.ticker,
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
    ticker: raw.ticker,
    selectionLabel: market.selectionLabel ?? undefined,
    isBlockTrade: raw.is_block_trade === true,
  };
}

async function resolveCachedKalshiPipelineEv(
  trades: FeedTrade[]
): Promise<Map<string, PipelineTradeEv>> {
  const index = new Map<string, PipelineTradeEv>();
  const byTicker = new Map<string, { ticker: string; price: number }>();

  for (const trade of trades) {
    if (!trade.ticker?.trim()) continue;
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

function kalshiTradeEvPercent(
  trade: FeedTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): number | null {
  if (!trade.ticker?.trim()) return null;
  const ticker = trade.ticker.trim().toUpperCase();
  const lookupKey = normalizePipelineLookupKey(`kalshi:${ticker}`, "kalshi");
  const pipeline = pipelineEvIndex.get(lookupKey);
  return resolveFeedTradeEvPercent({ price: trade.price }, pipeline ?? null);
}

export async function fetchKalshiTrades(
  minTs?: number
): Promise<FeedTrade[]> {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({ limit: "100" });
  if (minTs != null && minTs > 0) {
    params.set("min_ts", String(minTs));
  }

  const res = await kalshiFetch(`/markets/trades?${params}`, {
    next: { revalidate: 0 },
    label: "markets/trades",
  });

  if (!res.ok) {
    throw new Error(`Kalshi trades API error: ${res.status} ${res.statusText}`);
  }

  const data: unknown = await res.json();
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { trades?: unknown }).trades)
  ) {
    return [];
  }

  const raws = (data as { trades: KalshiRawTrade[] }).trades;
  const tickers = raws.map((raw) => raw.ticker).filter(Boolean);
  const marketCache = await resolveKalshiMarkets(tickers);
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
    }
  }

  console.log(
    `[kalshi/trades] raw=${raws.length} normalized=${trades.length} stakeCandidates=${shadowCandidates.length}`
  );

  let shadowQueued = 0;
  if (shadowCandidates.length > 0) {
    const pipelineEvIndex = await resolveCachedKalshiPipelineEv(
      shadowCandidates.map((candidate) => candidate.normalized)
    );

    const { categorizeMarket } = await import("@/lib/categorizer");

    for (const { raw, normalized } of shadowCandidates) {
      const tradeEvPercent = kalshiTradeEvPercent(normalized, pipelineEvIndex);
      if (!meetsFeedTradeEvThreshold(tradeEvPercent)) continue;

      const category = await categorizeMarket(normalized.title, normalized.ticker, {
        backfillDb: true,
        marketKey: normalized.ticker,
      });

      queueKalshiShadowTrade({
        ...shadowInputFromRaw(raw, normalized, tradeEvPercent),
        category,
      });
      shadowQueued += 1;
    }
  }

  if (shadowCandidates.length > 0) {
    console.log(
      `[kalshi/trades] evQualified=${shadowQueued} shadowQueued=${shadowQueued}`
    );
  }

  const stakeQualified = trades.filter((trade) =>
    meetsProductFeedStakeThreshold(trade.usdNotional)
  );
  const pipelineEvIndex =
    stakeQualified.length > 0
      ? await resolveCachedKalshiPipelineEv(stakeQualified)
      : new Map<string, PipelineTradeEv>();

  return trades.map((trade) => {
    if (!meetsProductFeedStakeThreshold(trade.usdNotional)) return trade;
    const netEvPercent = kalshiTradeEvPercent(trade, pipelineEvIndex);
    return {
      ...trade,
      netEvPercent,
    };
  });
}
