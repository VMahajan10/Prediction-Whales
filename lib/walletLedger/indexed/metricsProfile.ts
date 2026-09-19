import { auditLog } from "@/lib/walletLedger/indexed/auditProgress";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import type { ComputeWalletLedgerMetricsInput } from "@/lib/walletLedger/metrics";
import type { WalletLedgerMetrics } from "@/lib/walletLedger/types";

export interface MetricsProfileReport {
  totalMs: number;
  positionCount: number;
  computeMetricsMs: number;
  historyComplete: boolean;
  historyCompletenessReasons: string[];
  completenessBreakdown: Record<string, boolean>;
}

export function explainHistoryCompleteness(metrics: WalletLedgerMetrics): Record<string, boolean> {
  const reasons = new Set(metrics.historyCompletenessReasons);
  return {
    eventHistoryComplete:
      !reasons.has("no_history_events") &&
      !metrics.activityTruncated &&
      !metrics.tradesTruncated,
    resolutionComplete:
      metrics.resolutionCoverage.positionsRequiringResolution === 0 ||
      metrics.resolutionCoverage.resolutionCoveragePct >= 1,
    identityComplete:
      !reasons.has("identity_ambiguous") &&
      !reasons.has("identity_unresolved") &&
      !reasons.has("identity_low_confidence") &&
      !reasons.has("positions_without_history_events"),
    truncationDetected:
      metrics.activityTruncated || metrics.tradesTruncated,
    openPositions: metrics.openPositionCount > 0,
    gammaResolutionIncomplete: reasons.has("gamma_resolution_incomplete"),
    gammaResolutionMissingOnHeld: reasons.has(
      "gamma_resolution_missing_on_held_positions"
    ),
    mergeSplitMaterial: reasons.has("merge_split_material"),
    mergeSplitUnresolved: reasons.has("merge_split_unresolved"),
    historyValidityComplete: metrics.historyValidity === "complete",
    allReasonsCleared: reasons.size === 0,
    certifiedHistoryComplete: metrics.historyComplete,
  };
}

export function computeWalletLedgerMetricsProfiled(
  input: ComputeWalletLedgerMetricsInput
): { metrics: WalletLedgerMetrics; profile: MetricsProfileReport } {
  const totalStarted = Date.now();
  const computeStarted = Date.now();
  const metrics = computeWalletLedgerMetrics(input);
  const computeMetricsMs = Date.now() - computeStarted;

  const profile: MetricsProfileReport = {
    totalMs: Date.now() - totalStarted,
    positionCount: input.positions.length,
    computeMetricsMs,
    historyComplete: metrics.historyComplete,
    historyCompletenessReasons: metrics.historyCompletenessReasons,
    completenessBreakdown: explainHistoryCompleteness(metrics),
  };

  auditLog(
    `[metrics-profile] positions=${profile.positionCount} computeMs=${profile.computeMetricsMs} historyComplete=${profile.historyComplete} reasons=${profile.historyCompletenessReasons.join(",") || "none"}`
  );

  return { metrics, profile };
}
