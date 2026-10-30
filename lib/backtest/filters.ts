import type {
  BacktestFill,
  BacktestWindowConfig,
  MarketResolution,
  TradeClvRecord,
} from "@/lib/backtest/types";

export function heldAssetSettlement(
  fill: BacktestFill,
  resolution: MarketResolution
): 0 | 1 | null {
  if (!resolution.winningAsset || !fill.assetId) return null;
  const won =
    fill.assetId.trim().toLowerCase() ===
    resolution.winningAsset.trim().toLowerCase();
  return won ? 1 : 0;
}

export function isMarketResolvableForClv(resolution: MarketResolution): boolean {
  return (
    resolution.resolutionFinal === true &&
    resolution.resolutionStatus === "resolved" &&
    resolution.resolvedAt != null
  );
}

export interface MarketFilterResult {
  pass: boolean;
  reason?:
    | "unresolved_market"
    | "disputed_market"
    | "post_resolution_fill"
    | "unresolved_at_window_end"
    | "pre_close"
    | "missing_condition"
    | "missing_asset";
}

export function applyMarketFilters(
  fill: BacktestFill,
  resolution: MarketResolution | undefined,
  config: BacktestWindowConfig,
  rankEndUnix: number
): MarketFilterResult & { rankingEligible: boolean } {
  if (!fill.conditionId?.trim()) {
    return { pass: false, reason: "missing_condition", rankingEligible: false };
  }
  if (!fill.assetId?.trim()) {
    return { pass: false, reason: "missing_asset", rankingEligible: false };
  }
  if (!resolution) {
    return { pass: false, reason: "unresolved_market", rankingEligible: false };
  }
  if (
    resolution.resolutionStatus === "unresolved_or_disputed" ||
    !resolution.resolutionFinal
  ) {
    return {
      pass: false,
      reason:
        resolution.resolutionStatus === "unresolved_or_disputed"
          ? "disputed_market"
          : "unresolved_market",
      rankingEligible: false,
    };
  }
  if (resolution.resolvedAt == null) {
    return { pass: false, reason: "unresolved_market", rankingEligible: false };
  }

  const rankingEligible =
    config.clvResolutionMode === "final" ||
    resolution.resolvedAt <= rankEndUnix;

  if (
    config.clvResolutionMode === "ranking" &&
    resolution.resolvedAt > rankEndUnix
  ) {
    return {
      pass: false,
      reason: "unresolved_at_window_end",
      rankingEligible: false,
    };
  }

  if (fill.timestamp > resolution.resolvedAt) {
    return { pass: false, reason: "post_resolution_fill", rankingEligible };
  }
  const preCloseSec = config.preCloseMinutes * 60;
  if (fill.timestamp > resolution.resolvedAt - preCloseSec) {
    return { pass: false, reason: "pre_close", rankingEligible };
  }
  return { pass: true, rankingEligible };
}

export function filterWalletsByMinTrades(
  records: TradeClvRecord[],
  minTrades: number
): TradeClvRecord[] {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (
      r.exclusionReason === "unresolved_market" ||
      r.exclusionReason === "disputed_market" ||
      r.exclusionReason === "missing_condition" ||
      r.exclusionReason === "missing_asset" ||
      r.exclusionReason === "unresolved_at_window_end"
    ) {
      continue;
    }
    const key = r.walletAddress.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const eligible = new Set(
    [...counts.entries()]
      .filter(([, n]) => n >= minTrades)
      .map(([w]) => w)
  );
  return records.filter((r) => eligible.has(r.walletAddress.toLowerCase()));
}
