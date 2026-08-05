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
  value: string;
  sublabel?: string;
  positive: boolean;
  negative: boolean;
}

/** Feed card Trade EV label — Kalshi shows implied / market-price when EV is unknown. */
export function resolveFeedTradeEvDisplay(
  trade: {
    price: number;
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
        value: "0.0%",
        sublabel: "Market Price",
        positive: false,
        negative: false,
      };
    }
    return {
      value: formatEvPercent(tradeEvPercent),
      positive: tradeEvPercent > 0,
      negative: tradeEvPercent < -0.05,
    };
  }

  if (trade.source === "kalshi") {
    const implied = normalizeIncomingTradePrice(trade.price);
    if (implied != null) {
      return {
        value: `Implied: ${(implied * 100).toFixed(1)}%`,
        positive: false,
        negative: false,
      };
    }
  }

  return {
    value: "N/A",
    positive: false,
    negative: false,
  };
}
