import { isAuthoritativePipelineTradeEv } from "@/lib/evPipeline/pTrueAuthority";
import {
  deriveEvPercentFromPTrue,
  normalizeIncomingTradePrice,
} from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import { meetsFeedTradeEvThreshold } from "@/lib/feedQualification";

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
    const fromEntry = entryPriceEvPercent(pipeline.pTrue, trade.price);
    if (fromEntry != null) return fromEntry;

    return deriveEvPercentFromPTrue(
      pipeline.pTrue!,
      trade.price,
      pipeline.pMarket ?? pipeline.pmMid ?? pipeline.kalshiMid
    );
  }

  return null;
}

/** EV% vs entry: ((fair − entry) / entry) × 100 — not raw implied probability. */
export function entryPriceEvPercent(
  fairProbability: number,
  entryPrice: number
): number | null {
  const entry = normalizeIncomingTradePrice(entryPrice);
  if (entry == null || entry <= 0 || !Number.isFinite(fairProbability)) {
    return null;
  }
  return ((fairProbability - entry) / entry) * 100;
}

/** Trade passes the product feed EV floor (+3.0%). */
export function passesFeedTradeEvGate(
  tradeEvPercent: number | null | undefined
): boolean {
  if (tradeEvPercent == null || !Number.isFinite(tradeEvPercent)) {
    return false;
  }
  return meetsFeedTradeEvThreshold(tradeEvPercent);
}

export interface FeedTradeEvDisplay {
  label: string;
  value: string;
  sublabel?: string;
  positive: boolean;
  negative: boolean;
}

function formatFeedEvValue(evPercent: number): string {
  return `${formatEvPercent(evPercent)} EV`;
}

/** Feed card Trade EV — authoritative EV only; no implied-prob substitutes. */
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
    return {
      label: "TRADE EV",
      value: formatFeedEvValue(tradeEvPercent),
      positive: tradeEvPercent > 0,
      negative: tradeEvPercent < -0.05,
    };
  }

  return {
    label: "TRADE EV",
    value: "N/A",
    positive: false,
    negative: false,
  };
}
