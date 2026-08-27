import {
  MIN_FEED_TRADE_EV_PCT,
  FEED_ALLOW_MISSING_EV,
  getProductFeedMinEvPercentForLog,
  meetsProductFeedEvThreshold,
  MIN_PRODUCT_FEED_STAKE_USD,
  meetsProductFeedStakeThreshold,
} from "@/lib/feedQualification";
import {
  resolveContractMidEvFallback,
  resolveFeedTradeEvPercent,
  entryPriceEvPercent,
} from "@/lib/feedTradeEv";
import { logger } from "@/lib/logger";
import { KALSHI_TRADER_ALIAS } from "@/lib/trades/whaleAliasConstants";
import { normalizeFeedPlatform } from "@/lib/liveFeedMerge";
import { normalizeKalshiTicker } from "@/lib/evPipeline/crossAssetLookup";
import {
  normalizeKalshiOutcomeSide,
  pipelineFairMidsForKalshiOutcome,
} from "@/lib/evPipeline/kalshiOutcomeEv";
import { normalizeIncomingTradePrice } from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { resolvePipelineEvForWhale } from "@/lib/pipelineEvLookupHelpers";
import { hasSafeKalshiNamedSelection } from "@/lib/feed/kalshiFeedDirection";
import { tradeToWhale, type WhaleTrade } from "@/lib/whaleTrades";

export {
  hasSafeKalshiNamedSelection,
  resolveKalshiFeedDirectionLabel,
  resolveKalshiNamedSelection,
} from "@/lib/feed/kalshiFeedDirection";

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
      side: trade.side ?? "BUY",
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
      ticker: normalizeKalshiTicker(trade.ticker) ?? undefined,
    }
  );

  const netEvPercent =
    options?.netEvPercent ?? trade.netEvPercent ?? null;

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
  pipeline?: PipelineTradeEv | null,
  outcome?: string | null
): number | null {
  const outcomeSide = normalizeKalshiOutcomeSide(outcome);
  const adjusted = pipeline
    ? {
        ...pipeline,
        ...pipelineFairMidsForKalshiOutcome(pipeline, outcomeSide),
      }
    : null;
  return resolveContractMidEvFallback(entryPrice, adjusted);
}

/** Resolve Kalshi feed trade EV — authoritative pipeline first, then contract mid fallback. */
export function resolveKalshiFeedTradeEvPercent(
  trade: WhaleTrade,
  pipeline?: PipelineTradeEv | null
): number | null {
  if (trade.netEvPercent != null && Number.isFinite(trade.netEvPercent)) {
    return trade.netEvPercent;
  }

  // Unmapped rows carry YES-space mids — resolve in outcome space before the
  // generic feed resolver compares raw pmMid/kalshiMid to the entry price.
  if (
    pipeline &&
    (pipeline.status === "unmapped" || pipeline.status === "timeout")
  ) {
    const contractFallback = resolveKalshiContractEvFallback(
      trade.price,
      pipeline,
      trade.outcome
    );
    if (contractFallback != null) return contractFallback;

    const entryFallback = resolveKalshiUnmappedEntryEvFallback(trade, pipeline);
    if (entryFallback != null) return entryFallback;
  }

  const authoritative = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    pipeline
  );
  if (authoritative != null) return authoritative;

  const contractFallback = resolveKalshiContractEvFallback(
    trade.price,
    pipeline,
    trade.outcome
  );
  if (contractFallback != null) return contractFallback;

  return resolveKalshiUnmappedEntryEvFallback(trade, pipeline);
}

/**
 * When the pipeline index misses (null) or returns unmapped without mids,
 * use stamped poll EV or entry-anchored edge vs implied market reference.
 */
function resolveKalshiUnmappedEntryEvFallback(
  trade: WhaleTrade,
  pipeline?: PipelineTradeEv | null
): number | null {
  if (!meetsKalshiFeedStakeThreshold(trade)) return null;

  const entry = normalizeIncomingTradePrice(trade.price);
  if (entry == null || entry <= 0) return null;

  const outcomeSide = normalizeKalshiOutcomeSide(trade.outcome);
  const fairMids = pipeline
    ? pipelineFairMidsForKalshiOutcome(pipeline, outcomeSide)
    : null;

  const impliedMarket =
    fairMids?.pMarket ??
    fairMids?.kalshiMid ??
    fairMids?.pmMid ??
    null;

  if (fairMids?.pTrue != null && Number.isFinite(fairMids.pTrue)) {
    const fromPTrue = entryPriceEvPercent(fairMids.pTrue, entry);
    if (fromPTrue != null) return fromPTrue;
  }

  if (impliedMarket != null && Number.isFinite(impliedMarket)) {
    return entryPriceEvPercent(impliedMarket, entry);
  }

  return null;
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
    case "trade_ev": {
      const minEv = getProductFeedMinEvPercentForLog();
      return minEv == null
        ? "calculatedEv below relaxed product feed minimum"
        : `calculatedEv below minimum (+${minEv}% / ${(minEv / 100).toFixed(4)})`;
    }
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
  logger.debug(
    `[Kalshi Feed Gate Reject] id=${id} | ticker=${result.ticker ?? "none"} | calculatedEv=${formatEvForLog(result.calculatedEvPercent)} | stake=${formatStakeForLog(result.stakeUsd)} | requiredEv>=${getProductFeedMinEvPercentForLog() ?? "any"}${FEED_ALLOW_MISSING_EV ? " (missing allowed)" : ""} | requiredStake>=${formatStakeForLog(result.requiredStakeFloorUsd)} | pipelineStatus=${result.pipelineStatus ?? "missing"} | reason=${result.reason} (${rejectionReasonLabel(result.reason!)}) | title=${trade.title?.slice(0, 80) ?? ""}`
  );
}

export function diagnoseKalshiFeedTradeGate(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): KalshiFeedGateResult {
  const requiredEvPercent =
    getProductFeedMinEvPercentForLog() ?? MIN_FEED_TRADE_EV_PCT;
  const base = {
    stakeUsd: trade.usdNotional,
    requiredStakeFloorUsd: MIN_PRODUCT_FEED_STAKE_USD,
    requiredEvPercent,
    ticker: normalizeKalshiTicker(trade.ticker) ?? null,
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

  if (!base.ticker && !FEED_ALLOW_MISSING_EV) {
    return {
      passed: false,
      reason: "unmapped_ticker",
      calculatedEvPercent: null,
      ...base,
    };
  }

  const pipeline = base.ticker
    ? resolvePipelineEvForWhale(pipelineEvIndex, trade)
    : null;
  base.pipelineStatus = pipeline?.status ?? "missing";

  const tradeEvPercent = resolveKalshiFeedTradeEvPercent(trade, pipeline);
  const passedGate =
    meetsKalshiFeedStakeThreshold(trade) &&
    meetsProductFeedEvThreshold(tradeEvPercent);

  if (isKalshiRow(trade)) {
    logger.debug("[Kalshi Pipeline]", {
      ticker: trade.ticker,
      stake: trade.usdNotional,
      evStatus: pipeline?.status ?? "missing",
      calculatedEv: tradeEvPercent,
      pipelineEv: pipeline?.netEvPercent ?? null,
      passedGate,
    });
  }

  if (
    !meetsProductFeedEvThreshold(tradeEvPercent) &&
    (tradeEvPercent == null || !Number.isFinite(tradeEvPercent))
  ) {
    if (FEED_ALLOW_MISSING_EV) {
      return {
        passed: true,
        reason: null,
        calculatedEvPercent: tradeEvPercent,
        ...base,
      };
    }
    return {
      passed: false,
      reason: "missing_trade_ev",
      calculatedEvPercent: tradeEvPercent,
      ...base,
    };
  }

  if (!meetsProductFeedEvThreshold(tradeEvPercent)) {
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
 * Kalshi product-feed gate — flat $500 stake + +3.0% trade EV only.
 * No Polymarket wallet credibility checks. Uses contract mid fallback when
 * pipeline ensemble EV is unmapped.
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

/**
 * User-facing feed visibility — stake/EV gate plus a safe named selection.
 * Shadow ingestion does not use this check.
 */
export function isKalshiTradeVisibleInUserFeed(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>,
  context?: KalshiFeedGateContext
): boolean {
  if (!isKalshiTradeEligibleForFeed(trade, pipelineEvIndex, context)) {
    return false;
  }
  return hasSafeKalshiNamedSelection(trade);
}
