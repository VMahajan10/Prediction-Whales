import type { MergeSplitImpactReport } from "@/lib/walletLedger/mergeSplitAnalysis";
import type {
  CredibilityMetricBundle,
  HistoryValidity,
  MetricValidity,
  PolymarketHistoryIdentity,
  PositionLifecycle,
  ResolutionCoverageReport,
  WalletLedgerAuditReport,
} from "@/lib/walletLedger/types";

const MERGE_SPLIT_AMBIGUOUS_THRESHOLD = 0.05;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function buildMetricBundle(
  positions: PositionLifecycle[],
  filter: (p: PositionLifecycle) => boolean
): CredibilityMetricBundle {
  const eligible = positions.filter(filter);
  const capitalValues = eligible
    .map((p) => p.capitalAtRisk)
    .filter((v) => v > 0);
  const roiValues = eligible
    .map((p) => p.positionRoi)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const totalCapitalAtRisk = capitalValues.reduce((sum, v) => sum + v, 0);
  const totalRealizedPnl = eligible.reduce(
    (sum, p) => sum + (p.realizedPnl ?? 0),
    0
  );
  const profitable = eligible.filter((p) => (p.realizedPnl ?? 0) > 0).length;
  const heldResolved = eligible.filter((p) => p.heldThroughResolution);
  const outcomeWins = heldResolved.filter((p) => p.outcomeCorrect === true).length;

  return {
    completedPositionCount: eligible.length,
    resolvedHeldPositionCount: heldResolved.length,
    profitablePositionRate:
      eligible.length > 0 ? profitable / eligible.length : null,
    portfolioRealizedRoi:
      totalCapitalAtRisk > 0 ? totalRealizedPnl / totalCapitalAtRisk : null,
    medianCapitalAtRisk: median(capitalValues),
    meanCapitalAtRisk:
      capitalValues.length > 0 ? totalCapitalAtRisk / capitalValues.length : 0,
    totalCapitalAtRisk,
    totalRealizedPnl,
    medianPositionRoi: roiValues.length > 0 ? median(roiValues) : null,
    outcomeWinRate:
      heldResolved.length > 0 ? outcomeWins / heldResolved.length : null,
    resolvedVolumeUsd: totalCapitalAtRisk,
    avgEv: null,
  };
}

export function computeResolutionCoverage(
  positions: PositionLifecycle[]
): ResolutionCoverageReport {
  const requiring = positions.filter(
    (p) =>
      p.completionReason === "held_through_resolution" ||
      (!p.fullyExited &&
        p.netShares > 0 &&
        p.grossBuyCash > 0 &&
        p.accountingStatus !== "requires_merge_split_resolution")
  );
  const requiringIds = new Set(requiring.map((p) => p.conditionId));
  const resolved = requiring.filter(
    (p) => p.resolution?.resolutionFinal === true
  );
  const unresolved = requiring.length - resolved.length;
  const positionsRequiringResolution = requiringIds.size;
  const positionsSuccessfullyResolved = new Set(
    resolved.map((p) => p.conditionId)
  ).size;

  return {
    positionsRequiringResolution,
    positionsSuccessfullyResolved,
    positionsUnresolved: Math.max(
      0,
      positionsRequiringResolution - positionsSuccessfullyResolved
    ),
    resolutionCoveragePct:
      positionsRequiringResolution > 0
        ? positionsSuccessfullyResolved / positionsRequiringResolution
        : 1,
  };
}

export interface ValidityInput {
  positions: PositionLifecycle[];
  identity: PolymarketHistoryIdentity;
  activityTruncated: boolean;
  tradesTruncated: boolean;
  resolutionCoverage: ResolutionCoverageReport;
  mergeSplit: MergeSplitImpactReport;
  hasHistoryEvents: boolean;
}

export function assessWalletLedgerValidity(
  input: ValidityInput
): Pick<
  WalletLedgerAuditReport,
  | "metricValidity"
  | "credibilityMetricsValid"
  | "historyValidity"
  | "historyComplete"
  | "historyCompletenessReasons"
  | "observedWindowMetrics"
  | "credibilityMetrics"
  | "resolutionCoverage"
> {
  const reasons: string[] = [];

  if (input.identity.resolutionMethod === "ambiguous") {
    reasons.push("identity_ambiguous");
  }
  if (input.identity.resolutionMethod === "unresolved") {
    reasons.push("identity_unresolved");
  }
  if (input.identity.confidence === "low") {
    reasons.push("identity_low_confidence");
  }
  if (input.identity.positionsOnlyMismatch) {
    reasons.push("positions_without_history_events");
  }
  if (!input.hasHistoryEvents) reasons.push("no_history_events");
  if (input.activityTruncated) reasons.push("activity_truncated");
  if (input.tradesTruncated) reasons.push("trades_truncated");

  const heldCompletedMissingGamma = input.positions.filter(
    (p) =>
      p.heldThroughResolution &&
      p.completed &&
      p.resolution &&
      !p.resolution.resolutionFinal
  ).length;
  if (heldCompletedMissingGamma > 0) {
    reasons.push("gamma_resolution_missing_on_held_positions");
  }

  if (
    input.resolutionCoverage.positionsRequiringResolution > 0 &&
    input.resolutionCoverage.resolutionCoveragePct < 1
  ) {
    reasons.push("gamma_resolution_incomplete");
  }

  if (input.mergeSplit.recommendation === "phase_2c_accounting_required") {
    reasons.push("merge_split_material");
  } else if (input.mergeSplit.ambiguousMergeSplit > 0) {
    reasons.push("merge_split_unresolved");
  }

  const observedFilter = (p: PositionLifecycle) =>
    p.completed && p.realizedPnl != null;
  const credibleFilter = (p: PositionLifecycle) =>
    p.completed &&
    !p.excludedFromMetrics &&
    p.realizedPnl != null &&
    (p.completionReason === "fully_exited" ||
      p.resolution?.resolutionFinal === true);

  const observedWindowMetrics = buildMetricBundle(
    input.positions,
    observedFilter
  );
  const credibleCandidate = buildMetricBundle(input.positions, credibleFilter);

  const truncationBlocksCredibility =
    input.activityTruncated || input.tradesTruncated;
  const identityBlocksCredibility =
    input.identity.confidence === "low" ||
    input.identity.resolutionMethod === "ambiguous" ||
    input.identity.resolutionMethod === "unresolved" ||
    input.identity.positionsOnlyMismatch ||
    !input.hasHistoryEvents;
  const mergeSplitBlocksCredibility =
    input.mergeSplit.pctAmbiguousOfCompleted >= MERGE_SPLIT_AMBIGUOUS_THRESHOLD;

  const gammaBlocksCredibility = heldCompletedMissingGamma > 0;

  const credibilityMetricsValid =
    !truncationBlocksCredibility &&
    !identityBlocksCredibility &&
    !gammaBlocksCredibility &&
    !mergeSplitBlocksCredibility;

  let metricValidity: MetricValidity;
  let historyValidity: HistoryValidity;

  if (identityBlocksCredibility && !input.hasHistoryEvents) {
    metricValidity = "unusable";
    historyValidity = "unusable";
  } else if (truncationBlocksCredibility) {
    metricValidity = "partial";
    historyValidity = "partial-and-metrics-unsafe";
  } else if (!credibilityMetricsValid) {
    metricValidity = "partial";
    historyValidity = "partial-and-metrics-unsafe";
  } else if (
    input.resolutionCoverage.positionsRequiringResolution > 0 &&
    input.resolutionCoverage.resolutionCoveragePct < 1
  ) {
    metricValidity = "complete";
    historyValidity = "partial-but-metrics-safe";
  } else {
    metricValidity = "complete";
    historyValidity = "complete";
  }

  const historyComplete =
    historyValidity === "complete" && reasons.length === 0;

  return {
    metricValidity,
    credibilityMetricsValid,
    historyValidity,
    historyComplete,
    historyCompletenessReasons: reasons,
    observedWindowMetrics,
    credibilityMetrics: credibilityMetricsValid ? credibleCandidate : null,
    resolutionCoverage: input.resolutionCoverage,
  };
}
