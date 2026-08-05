import { isAuthoritativePipelineTradeEv } from "@/lib/evPipeline/pTrueAuthority";
import { deriveEvPercentFromPTrue } from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import { normalizeIncomingTradePrice } from "@/lib/evPipeline/tradeEvRecord";

function tradeLevelEvPercent(input: {
  tradeEvPercent?: number | null;
  netEvPercent?: number | null;
  grossEvPercent?: number | null;
}): number | null {
  if (input.tradeEvPercent != null && Number.isFinite(input.tradeEvPercent)) {
    return input.tradeEvPercent;
  }
  for (const value of [input.netEvPercent, input.grossEvPercent]) {
    if (value != null && Number.isFinite(value)) return value;
  }
  return null;
}

/** Trade-level EV % for feed gates — never uses wallet averageEv / traderAvgEv. */
export function resolveFeedTradeEvPercent(
  trade: {
    price: number;
    tradeEvPercent?: number | null;
    netEvPercent?: number | null;
    grossEvPercent?: number | null;
  },
  pipeline?: PipelineTradeEv | null
): number | null {
  const fromTrade = tradeLevelEvPercent(trade);
  if (fromTrade != null) return fromTrade;

  if (
    !pipeline ||
    pipeline.status === "unmapped" ||
    pipeline.status === "timeout"
  ) {
    return null;
  }
  if (!isAuthoritativePipelineTradeEv(pipeline)) return null;

  const fromPipeline = tradeLevelEvPercent({
    netEvPercent: pipeline.netEvPercent,
    grossEvPercent: pipeline.grossEvPercent,
  });
  if (fromPipeline != null) return fromPipeline;

  if (pipeline.pTrue != null && Number.isFinite(pipeline.pTrue)) {
    return deriveEvPercentFromPTrue(
      pipeline.pTrue!,
      trade.price,
      pipeline.pMarket ?? pipeline.pmMid ?? pipeline.kalshiMid
    );
  }

  return null;
}

export interface FeedTradeEvDisplay {
  /** Stat box header — `TRADE EV` or `IMPLIED PROB`. */
  label: string;
  value: string;
  sublabel?: string;
  positive: boolean;
  negative: boolean;
}

function formatFeedEvValue(evPercent: number): string {
  return `${formatEvPercent(evPercent)} EV`;
}

function computeKalshiPriceEdgePercent(
  entryPrice: number,
  nowPrice: number,
  isBuy: boolean
): number | null {
  const entry = normalizeIncomingTradePrice(entryPrice);
  const now = normalizeIncomingTradePrice(nowPrice);
  if (entry == null || now == null) return null;

  if (isBuy) {
    if (entry <= 0) return null;
    return ((now - entry) / entry) * 100;
  }

  const entryNo = 1 - entry;
  const nowNo = 1 - now;
  if (entryNo <= 0) return null;
  return ((nowNo - entryNo) / entryNo) * 100;
}

/** Feed card EV / implied-prob display — never labels probability as EV. */
export function resolveFeedTradeEvDisplay(
  trade: {
    price: number;
    nowPrice?: number | null;
    isBuy?: boolean;
    source?: "polymarket" | "kalshi";
    tradeEvPercent?: number | null;
    netEvPercent?: number | null;
    grossEvPercent?: number | null;
    averageEv?: number | null;
  },
  pipeline?: PipelineTradeEv | null
): FeedTradeEvDisplay {
  const tradeEvPercent = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      tradeEvPercent: trade.tradeEvPercent ?? trade.averageEv ?? null,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    pipeline
  );

  if (tradeEvPercent != null && Number.isFinite(tradeEvPercent)) {
    const nearZero =
      Object.is(tradeEvPercent, -0) || Math.abs(tradeEvPercent) < 0.05;
    if (trade.source === "kalshi" && nearZero) {
      return {
        label: "TRADE EV",
        value: formatFeedEvValue(0),
        sublabel: "Market Price",
        positive: false,
        negative: false,
      };
    }
    return {
      label: "TRADE EV",
      value: formatFeedEvValue(tradeEvPercent),
      positive: tradeEvPercent > 0,
      negative: tradeEvPercent < -0.05,
    };
  }

  if (trade.source === "kalshi") {
    const isBuy = trade.isBuy ?? true;
    const liveNow = trade.nowPrice;
    if (
      liveNow != null &&
      Number.isFinite(liveNow) &&
      liveNow !== trade.price
    ) {
      const edge = computeKalshiPriceEdgePercent(trade.price, liveNow, isBuy);
      if (edge != null && Number.isFinite(edge)) {
        return {
          label: "TRADE EV",
          value: formatFeedEvValue(edge),
          positive: edge > 0,
          negative: edge < -0.05,
        };
      }
    }

    const implied = normalizeIncomingTradePrice(trade.price);
    if (implied != null) {
      return {
        label: "IMPLIED PROB",
        value: `${(implied * 100).toFixed(1)}%`,
        sublabel: "AT ENTRY",
        positive: false,
        negative: false,
      };
    }
  }

  return {
    label: "TRADE EV",
    value: "N/A",
    positive: false,
    negative: false,
  };
}
