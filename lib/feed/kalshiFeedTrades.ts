import {
  MIN_FEED_TRADE_EV_DECIMAL,
  MIN_FEED_TRADE_EV_PCT,
  MIN_PRODUCT_FEED_STAKE_USD,
  meetsFeedTradeEvThreshold,
  meetsProductFeedStakeThreshold,
} from "@/lib/feedQualification";
import {
  entryPriceEvPercent,
  resolveFeedTradeEvPercent,
} from "@/lib/feedTradeEv";
import { KALSHI_TRADER_ALIAS } from "@/lib/trades/whaleAliasConstants";
import { normalizeFeedPlatform } from "@/lib/liveFeedMerge";
import { normalizeIncomingTradePrice } from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { resolvePipelineEvForWhale } from "@/lib/pipelineEvClient";
import { tradeToWhale, type WhaleTrade } from "@/lib/whaleTrades";

/**
 * Structural input so this stays client-safe — importing `lib/kalshiTrades`
 * would pull the shadow-log writer into the browser bundle.
 */
export interface KalshiFeedTradeInput {
  id: string;
  title: string;
  outcome: string;
  side?: "BUY" | "SELL";
  price: number;
  usdNotional: number;
  timestamp: number;
  ticker?: string;
  selectionLabel?: string;
  netEvPercent?: number | null;
  category?: string;
}

export type KalshiFeedGateRejectReason =
  | "stake_floor"
  | "unmapped_ticker"
  | "missing_trade_ev"
  | "trade_ev";

export interface KalshiFeedGateContext {
  id?: string;
  /** When false, skip rejection console logs (tests). Default true when rejecting. */
  logRejection?: boolean;
}

export interface KalshiFeedGateResult {
  passed: boolean;
  reason: KalshiFeedGateRejectReason | null;
  calculatedEvPercent: number | null;
  stakeUsd: number;
  requiredStakeFloorUsd: number;
  requiredEvPercent: number;
  ticker: string | null;
  pipelineStatus: PipelineTradeEv["status"] | "missing" | null;
}

/**
 * Kalshi rows carry no wallet or trader identity — Kalshi's public API exposes
 * none, and profiling members is prohibited (see docs/Kalshi Whale Attribution
 * Audit.md). `proxyWallet` and `whaleIdentity` stay unset by design.
 */
export function kalshiFeedTradeToWhale(
  trade: KalshiFeedTradeInput,
  options?: {
    isLive?: boolean;
    netEvPercent?: number | null;
  }
): WhaleTrade {
  const whale = tradeToWhale(
    {
      id: trade.id,
      title: trade.title,
      side: trade.side ?? (trade.outcome === "Yes" ? "BUY" : "SELL"),
      outcome: trade.outcome,
      price: trade.price,
      size: trade.usdNotional,
      timestamp: trade.timestamp,
      transactionHash: "",
    },
    {
      detectedAt: trade.timestamp * 1000,
      isLive: options?.isLive ?? true,
      usdNotional: trade.usdNotional,
      source: "kalshi",
      ticker: trade.ticker,
    }
  );

  const netEvPercent = options?.netEvPercent ?? null;

  return {
    ...whale,
    platform: "KALSHI",
    selectionLabel: trade.selectionLabel,
    averageEv: netEvPercent,
    netEvPercent,
    grossEvPercent: null,
    category: trade.category,
    whaleAlias: KALSHI_TRADER_ALIAS,
  };
}

function isKalshiRow(trade: WhaleTrade): boolean {
  if (trade.source === "polymarket") return false;
  return normalizeFeedPlatform(trade) === "kalshi";
}

/** Kalshi product-feed stake gate — flat $500 notional (matches server ingestion). */
export function meetsKalshiFeedStakeThreshold(trade: WhaleTrade): boolean {
  if (!isKalshiRow(trade)) return false;
  return meetsProductFeedStakeThreshold(trade.usdNotional);
}

/** Kalshi product-feed stake gate — flat $500, no wallet checks. */
export function isKalshiTradeStakeCandidate(trade: WhaleTrade): boolean {
  return isKalshiRow(trade) && meetsKalshiFeedStakeThreshold(trade);
}

/**
 * Kalshi-only EV fallback when ensemble pipeline EV is missing or unmapped:
 * 1) cross-venue PM mid vs Kalshi execution price
 * 2) standalone Kalshi mid vs execution price
 * Mirrors server `buildKalshiTradeEvFallback` using fields already on the index row.
 */
export function resolveKalshiContractEvFallback(
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
    Number.isFinite(pipeline.netEvPercent)
  ) {
    return pipeline.netEvPercent;
  }

  return null;
}

/** Resolve Kalshi feed trade EV — authoritative pipeline first, then contract mid fallback. */
export function resolveKalshiFeedTradeEvPercent(
  trade: WhaleTrade,
  pipeline?: PipelineTradeEv | null
): number | null {
  const authoritative = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    pipeline
  );
  if (authoritative != null) return authoritative;

  return resolveKalshiContractEvFallback(trade.price, pipeline);
}

function formatEvForLog(evPercent: number | null): string {
  if (evPercent == null || !Number.isFinite(evPercent)) return "N/A";
  return `${evPercent}% (${(evPercent / 100).toFixed(4)})`;
}

function formatStakeForLog(stakeUsd: number): string {
  if (!Number.isFinite(stakeUsd)) return "N/A";
  return `$${stakeUsd.toFixed(2)}`;
}

function rejectionReasonLabel(reason: KalshiFeedGateRejectReason): string {
  switch (reason) {
    case "stake_floor":
      return `stake/notional below product feed minimum ($${MIN_PRODUCT_FEED_STAKE_USD})`;
    case "unmapped_ticker":
      return "missing Kalshi ticker — cannot resolve pipeline EV";
    case "missing_trade_ev":
      return "missing calculated trade EV after pipeline + contract mid fallback";
    case "trade_ev":
      return `calculatedEv below minimum (+${MIN_FEED_TRADE_EV_PCT}% / ${MIN_FEED_TRADE_EV_DECIMAL})`;
    default:
      return reason;
  }
}

/** Debug log emitted when a Kalshi trade fails the product feed gate. */
export function logKalshiFeedGateReject(
  result: KalshiFeedGateResult,
  context: KalshiFeedGateContext,
  trade: Pick<WhaleTrade, "id" | "title" | "ticker">
): void {
  const id = context.id ?? trade.id ?? "unknown";
  console.log(
    `[Kalshi Feed Gate Reject] id=${id} | ticker=${result.ticker ?? "none"} | calculatedEv=${formatEvForLog(result.calculatedEvPercent)} | stake=${formatStakeForLog(result.stakeUsd)} | requiredEv>=${MIN_FEED_TRADE_EV_PCT}% (${MIN_FEED_TRADE_EV_DECIMAL}) | requiredStake>=${formatStakeForLog(result.requiredStakeFloorUsd)} | pipelineStatus=${result.pipelineStatus ?? "missing"} | reason=${result.reason} (${rejectionReasonLabel(result.reason!)}) | title=${trade.title?.slice(0, 80) ?? ""}`
  );
}

export function diagnoseKalshiFeedTradeGate(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): KalshiFeedGateResult {
  const base = {
    stakeUsd: trade.usdNotional,
    requiredStakeFloorUsd: MIN_PRODUCT_FEED_STAKE_USD,
    requiredEvPercent: MIN_FEED_TRADE_EV_PCT,
    ticker: trade.ticker?.trim() || null,
    pipelineStatus: null as KalshiFeedGateResult["pipelineStatus"],
  };

  if (!isKalshiRow(trade)) {
    return {
      passed: false,
      reason: "stake_floor",
      calculatedEvPercent: null,
      ...base,
    };
  }

  if (!meetsKalshiFeedStakeThreshold(trade)) {
    return {
      passed: false,
      reason: "stake_floor",
      calculatedEvPercent: null,
      ...base,
    };
  }

  if (!base.ticker) {
    return {
      passed: false,
      reason: "unmapped_ticker",
      calculatedEvPercent: null,
      ...base,
    };
  }

  const pipeline = resolvePipelineEvForWhale(pipelineEvIndex, trade);
  base.pipelineStatus = pipeline?.status ?? "missing";

  const tradeEvPercent = resolveKalshiFeedTradeEvPercent(trade, pipeline);

  if (tradeEvPercent == null || !Number.isFinite(tradeEvPercent)) {
    return {
      passed: false,
      reason: "missing_trade_ev",
      calculatedEvPercent: tradeEvPercent,
      ...base,
    };
  }

  if (!meetsFeedTradeEvThreshold(tradeEvPercent)) {
    return {
      passed: false,
      reason: "trade_ev",
      calculatedEvPercent: tradeEvPercent,
      ...base,
    };
  }

  return {
    passed: true,
    reason: null,
    calculatedEvPercent: tradeEvPercent,
    ...base,
  };
}

/**
 * Kalshi product-feed gate — flat $500 stake + trade EV >= +3.0%.
 * Uses contract mid fallback when pipeline ensemble EV is unmapped.
 */
export function evaluateKalshiFeedTradeGate(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  context: KalshiFeedGateContext = {}
): KalshiFeedGateResult {
  const result = diagnoseKalshiFeedTradeGate(trade, pipelineEvIndex);
  const shouldLog =
    !result.passed &&
    context.logRejection !== false &&
    (context.id != null || trade.id);

  if (shouldLog && result.reason) {
    logKalshiFeedGateReject(result, context, trade);
  }

  return result;
}

export function isKalshiTradeEligibleForFeed(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  context?: KalshiFeedGateContext
): boolean {
  return evaluateKalshiFeedTradeGate(trade, pipelineEvIndex, context).passed;
}
