import {
  isQualifiedLiveFeedTrade,
  MIN_FEED_TRADE_EV_DECIMAL,
  MIN_FEED_TRADE_EV_PCT,
  meetsFeedTradeEvThreshold,
  meetsProductFeedStakeThreshold,
  resolveLiveFeedStakeFloorUsd,
  type LiveFeedQualificationTrade,
} from "@/lib/feedQualification";
import { inferCategoryBadge } from "@/lib/marketCategory";
import { normalizeFeedCategory } from "@/lib/x-agent/stakeFloor";

export type FeedGateRejectReason =
  | "stake_floor"
  | "trade_ev"
  | "missing_trade_ev";

function resolveFeedGateCategoryLabel(input: {
  title?: string | null;
  category?: string | null;
}): string {
  const normalized = normalizeFeedCategory(input.category);
  if (normalized) return normalized;
  return inferCategoryBadge(input.title ?? "").label.toLowerCase();
}

export interface LiveFeedGateContext {
  id?: string;
  source?: "api" | "socket" | "client";
  /** When false, skip rejection console logs (tests). Default true when rejecting. */
  logRejection?: boolean;
}

export interface LiveFeedGateResult {
  passed: boolean;
  reason: FeedGateRejectReason | null;
  /** Pipeline trade-level EV % — never wallet historical averageEv. */
  calculatedEvPercent: number | null;
  stakeUsd: number;
  requiredStakeFloorUsd: number;
  requiredEvPercent: number;
  requiredEvDecimal: number;
}

function formatEvForLog(evPercent: number | null): string {
  if (evPercent == null || !Number.isFinite(evPercent)) return "N/A";
  return `${evPercent}% (${(evPercent / 100).toFixed(4)})`;
}

function formatStakeForLog(stakeUsd: number): string {
  if (!Number.isFinite(stakeUsd)) return "N/A";
  return `$${stakeUsd.toFixed(2)}`;
}

function rejectionReasonLabel(reason: FeedGateRejectReason): string {
  switch (reason) {
    case "stake_floor":
      return "stake/notional below product feed minimum";
    case "missing_trade_ev":
      return "missing calculated trade EV";
    case "trade_ev":
      return `calculatedEv below minimum (+${MIN_FEED_TRADE_EV_PCT}% / ${MIN_FEED_TRADE_EV_DECIMAL})`;
    default:
      return reason;
  }
}

/** Debug log emitted when a trade fails the live feed gate. */
export function logFeedGateReject(
  result: LiveFeedGateResult,
  context: LiveFeedGateContext,
  trade: LiveFeedQualificationTrade
): void {
  const category = resolveFeedGateCategoryLabel(trade);
  const id = context.id ?? "unknown";
  const source = context.source ?? "unknown";

  console.log(
    `[Feed Gate Reject] id=${id} | source=${source} | calculatedEv=${formatEvForLog(result.calculatedEvPercent)} | stake=${formatStakeForLog(result.stakeUsd)} | notional=${formatStakeForLog(result.stakeUsd)} | requiredEv>=${MIN_FEED_TRADE_EV_PCT}% (${MIN_FEED_TRADE_EV_DECIMAL}) | requiredStake>=${formatStakeForLog(result.requiredStakeFloorUsd)} | category=${category} | reason=${result.reason} (${rejectionReasonLabel(result.reason!)})`
  );
}

export function diagnoseLiveFeedTradeGate(
  trade: LiveFeedQualificationTrade
): LiveFeedGateResult {
  const category =
    trade.category ?? resolveFeedGateCategoryLabel(trade);
  const requiredStakeFloorUsd = resolveLiveFeedStakeFloorUsd({
    ...trade,
    category,
  });
  const calculatedEvPercent = trade.tradeEvPercent ?? null;

  if (!meetsProductFeedStakeThreshold(trade.stakeUsd)) {
    return {
      passed: false,
      reason: "stake_floor",
      calculatedEvPercent,
      stakeUsd: trade.stakeUsd,
      requiredStakeFloorUsd,
      requiredEvPercent: MIN_FEED_TRADE_EV_PCT,
      requiredEvDecimal: MIN_FEED_TRADE_EV_DECIMAL,
    };
  }

  if (calculatedEvPercent == null || !Number.isFinite(calculatedEvPercent)) {
    return {
      passed: false,
      reason: "missing_trade_ev",
      calculatedEvPercent,
      stakeUsd: trade.stakeUsd,
      requiredStakeFloorUsd,
      requiredEvPercent: MIN_FEED_TRADE_EV_PCT,
      requiredEvDecimal: MIN_FEED_TRADE_EV_DECIMAL,
    };
  }

  if (!meetsFeedTradeEvThreshold(calculatedEvPercent)) {
    return {
      passed: false,
      reason: "trade_ev",
      calculatedEvPercent,
      stakeUsd: trade.stakeUsd,
      requiredStakeFloorUsd,
      requiredEvPercent: MIN_FEED_TRADE_EV_PCT,
      requiredEvDecimal: MIN_FEED_TRADE_EV_DECIMAL,
    };
  }

  return {
    passed: true,
    reason: null,
    calculatedEvPercent,
    stakeUsd: trade.stakeUsd,
    requiredStakeFloorUsd,
    requiredEvPercent: MIN_FEED_TRADE_EV_PCT,
    requiredEvDecimal: MIN_FEED_TRADE_EV_DECIMAL,
  };
}

/**
 * Central live-feed gate: tiered stake/notional floor + trade calculatedEv >= +3.0%.
 * Logs rejections with calculatedEv, stake/notional, and exact reason when context is provided.
 */
export function evaluateLiveFeedTradeGate(
  trade: LiveFeedQualificationTrade,
  context: LiveFeedGateContext = {}
): LiveFeedGateResult {
  const result = diagnoseLiveFeedTradeGate(trade);
  const shouldLog =
    !result.passed &&
    context.logRejection !== false &&
    (context.id != null || context.source != null);

  if (shouldLog && result.reason) {
    logFeedGateReject(result, context, trade);
  }

  return result;
}

export function passesLiveFeedTradeGate(
  trade: LiveFeedQualificationTrade,
  context?: LiveFeedGateContext
): boolean {
  return evaluateLiveFeedTradeGate(trade, context).passed;
}

/** @deprecated Prefer {@link passesLiveFeedTradeGate} — kept for boolean-only call sites. */
export function isQualifiedLiveFeedTradeWithLogging(
  trade: LiveFeedQualificationTrade,
  context?: LiveFeedGateContext
): boolean {
  return passesLiveFeedTradeGate(trade, context);
}
