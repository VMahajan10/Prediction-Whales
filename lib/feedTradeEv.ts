import { isAuthoritativePipelineTradeEv } from "@/lib/evPipeline/pTrueAuthority";
import {
  deriveEvPercentFromPTrue,
  isStaleZeroAverageEvPayload,
  isStaleZeroTradeEvPayload,
  normalizeIncomingTradePrice,
} from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import { meetsProductFeedEvThreshold } from "@/lib/feedQualification";

export interface TradeEvPercentInput {
  tradeEvPercent?: number | null;
  netEvPercent?: number | null;
  grossEvPercent?: number | null;
  averageEv?: number | null;
  /** Decimal EV (+3% → 0.03) from normalized API payloads. */
  ev?: number | null;
  tradeEv?: number | null;
  evPercent?: number | null;
}

function tradeLevelEvPercent(input: TradeEvPercentInput): number | null {
  return coalesceTradeEvPercent(input);
}

/** Trade-level EV % from any common API / feed field name. */
export function coalesceTradeEvPercent(
  trade: TradeEvPercentInput | null | undefined
): number | null {
  if (!trade) return null;

  const evFields = {
    netEvPercent: trade.netEvPercent ?? null,
    grossEvPercent: trade.grossEvPercent ?? null,
    averageEv: trade.averageEv ?? null,
  };

  if (trade.tradeEvPercent != null && Number.isFinite(trade.tradeEvPercent)) {
    return trade.tradeEvPercent;
  }
  if (trade.netEvPercent != null && Number.isFinite(trade.netEvPercent)) {
    if (!isStaleZeroTradeEvPayload(evFields)) {
      return trade.netEvPercent;
    }
  }
  if (trade.evPercent != null && Number.isFinite(trade.evPercent)) {
    return trade.evPercent;
  }
  if (trade.tradeEv != null && Number.isFinite(trade.tradeEv)) {
    return trade.tradeEv;
  }
  if (trade.grossEvPercent != null && Number.isFinite(trade.grossEvPercent)) {
    return trade.grossEvPercent;
  }
  if (
    trade.averageEv != null &&
    Number.isFinite(trade.averageEv) &&
    !isStaleZeroAverageEvPayload(evFields) &&
    !(trade.averageEv === 0 && isStaleZeroTradeEvPayload(evFields))
  ) {
    return trade.averageEv;
  }

  const ev = trade.ev;
  if (ev != null && Number.isFinite(ev)) {
    return Math.abs(ev) <= 1 ? ev * 100 : ev;
  }

  return null;
}

/**
 * Cross-venue / standalone contract mid vs execution price — used when ensemble
 * EV is unmapped but order-book mids are present on the pipeline row.
 */
export function resolveContractMidEvFallback(
  entryPrice: number,
  pipeline?: PipelineTradeEv | null
): number | null {
  if (!pipeline) return null;

  const executionPrice = normalizeIncomingTradePrice(entryPrice);
  if (executionPrice == null || executionPrice <= 0) return null;

  if (pipeline.pmMid != null && Number.isFinite(pipeline.pmMid)) {
    return entryPriceEvPercent(pipeline.pmMid, executionPrice);
  }

  if (pipeline.kalshiMid != null && Number.isFinite(pipeline.kalshiMid)) {
    return entryPriceEvPercent(pipeline.kalshiMid, executionPrice);
  }

  if (
    pipeline.netEvPercent != null &&
    Number.isFinite(pipeline.netEvPercent) &&
    !isStaleZeroTradeEvPayload(pipeline)
  ) {
    return pipeline.netEvPercent;
  }

  return null;
}

/** Prefer entry-anchored EV when pipeline netEvPercent is a stale mid-based zero. */
function resolveAuthoritativePipelineEvPercent(
  tradePrice: number,
  pipeline: PipelineTradeEv
): number | null {
  const fromPipeline = tradeLevelEvPercent({
    netEvPercent: pipeline.netEvPercent,
    grossEvPercent: pipeline.grossEvPercent,
  });

  if (fromPipeline != null && fromPipeline !== 0) {
    return fromPipeline;
  }

  if (fromPipeline === 0) {
    const fromMid = resolveContractMidEvFallback(tradePrice, pipeline);
    if (fromMid != null && Math.abs(fromMid) > 0.05) return fromMid;

    if (pipeline.pTrue != null && Number.isFinite(pipeline.pTrue)) {
      const fromEntry = entryPriceEvPercent(pipeline.pTrue, tradePrice);
      if (fromEntry != null && Math.abs(fromEntry) > 0.05) return fromEntry;

      const derived = deriveEvPercentFromPTrue(
        pipeline.pTrue,
        tradePrice,
        pipeline.pMarket ?? pipeline.pmMid ?? pipeline.kalshiMid
      );
      if (derived != null && Math.abs(derived) > 0.05) return derived;
    }

    if (isStaleZeroTradeEvPayload(pipeline)) {
      return fromMid ?? null;
    }
  }

  return fromPipeline;
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

  if (!pipeline) return null;

  if (pipeline.status === "unmapped" || pipeline.status === "timeout") {
    return resolveContractMidEvFallback(trade.price, pipeline);
  }

  if (!isAuthoritativePipelineTradeEv(pipeline)) return null;

  const fromPipeline = resolveAuthoritativePipelineEvPercent(trade.price, pipeline);
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
  return meetsProductFeedEvThreshold(tradeEvPercent);
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
  trade: TradeEvPercentInput & {
    price: number;
    source?: "polymarket" | "kalshi";
  },
  pipeline?: PipelineTradeEv | null
): FeedTradeEvDisplay {
  const tradeEvPercent = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      tradeEvPercent: coalesceTradeEvPercent(trade),
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
