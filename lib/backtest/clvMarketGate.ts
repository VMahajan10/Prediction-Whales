import type { BacktestFill, BacktestWindowConfig, MarketResolution } from "@/lib/backtest/types";
import type { MarketSchedule } from "@/lib/backtest/marketSchedule";

export interface ClvMarketGateResult {
  pass: boolean;
  rankingEligible: boolean;
  reason?:
    | "unresolved_market"
    | "disputed_market"
    | "post_resolution_fill"
    | "unresolved_at_window_end"
    | "pre_close"
    | "missing_condition"
    | "missing_asset"
    | "after_closing_cutoff";
}

export function applyClvMarketGate(
  fill: BacktestFill,
  resolution: MarketResolution | undefined,
  schedule: MarketSchedule | undefined,
  config: BacktestWindowConfig,
  rankEndUnix: number
): ClvMarketGateResult {
  if (!fill.conditionId?.trim()) {
    return { pass: false, rankingEligible: false, reason: "missing_condition" };
  }
  if (!fill.assetId?.trim()) {
    return { pass: false, rankingEligible: false, reason: "missing_asset" };
  }
  if (!schedule?.closingCutoffUnix) {
    return { pass: false, rankingEligible: false, reason: "unresolved_market" };
  }

  const cutoff = schedule.closingCutoffUnix;
  if (fill.timestamp >= cutoff) {
    return {
      pass: false,
      rankingEligible: false,
      reason: "after_closing_cutoff",
    };
  }

  let rankingEligible = true;
  if (resolution?.resolvedAt != null) {
    rankingEligible =
      config.clvResolutionMode === "final" ||
      resolution.resolvedAt <= rankEndUnix;
    if (
      config.clvResolutionMode === "ranking" &&
      resolution.resolvedAt > rankEndUnix
    ) {
      return {
        pass: false,
        rankingEligible: false,
        reason: "unresolved_at_window_end",
      };
    }
    if (fill.timestamp > resolution.resolvedAt) {
      return { pass: false, rankingEligible, reason: "post_resolution_fill" };
    }
    const preCloseSec = config.preCloseMinutes * 60;
    if (fill.timestamp > resolution.resolvedAt - preCloseSec) {
      return { pass: false, rankingEligible, reason: "pre_close" };
    }
  }

  if (
    resolution?.resolutionStatus === "unresolved_or_disputed" &&
    resolution.resolutionFinal === false
  ) {
    return { pass: false, rankingEligible: false, reason: "disputed_market" };
  }

  return { pass: true, rankingEligible };
}
