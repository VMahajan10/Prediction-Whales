import type { MergeSplitImpactReport } from "@/lib/walletLedger/mergeSplitAnalysis";
import type {
  CredibilityMetricBundle,
  GammaCoverageReport,
  PolymarketHistoryIdentity,
  PositionLifecycle,
  ResolutionCoverageReport,
  WalletLedgerMetrics,
} from "@/lib/walletLedger/types";
import {
  assessWalletLedgerValidity,
  computeResolutionCoverage,
} from "@/lib/walletLedger/validity";

export interface ComputeWalletLedgerMetricsInput {
  positions: PositionLifecycle[];
  identity: PolymarketHistoryIdentity;
  activityTruncated: boolean;
  tradesTruncated: boolean;
  rawEventCount: number;
  deduplicatedEventCount: number;
  gammaCoverage: GammaCoverageReport;
  mergeSplit: MergeSplitImpactReport;
  hasHistoryEvents: boolean;
  historicalBackfillRequired?: boolean;
  unresolvedChainOrderBlocksCredibility?: boolean;
  unresolvedChainEvents?: number;
  unresolvedChainEventsInLifecycle?: number;
  affectedPositionGroups?: number;
}

function bundleToTopLevel(bundle: CredibilityMetricBundle): Pick<
  WalletLedgerMetrics,
  | "completedPositionCount"
  | "resolvedHeldPositionCount"
  | "profitablePositionRate"
  | "portfolioRealizedRoi"
  | "medianCapitalAtRisk"
  | "meanCapitalAtRisk"
  | "totalCapitalAtRisk"
  | "totalRealizedPnl"
  | "medianPositionRoi"
  | "outcomeWinRate"
  | "resolvedVolumeUsd"
  | "avgEv"
> {
  return {
    completedPositionCount: bundle.completedPositionCount,
    resolvedHeldPositionCount: bundle.resolvedHeldPositionCount,
    profitablePositionRate: bundle.profitablePositionRate,
    portfolioRealizedRoi: bundle.portfolioRealizedRoi,
    medianCapitalAtRisk: bundle.medianCapitalAtRisk,
    meanCapitalAtRisk: bundle.meanCapitalAtRisk,
    totalCapitalAtRisk: bundle.totalCapitalAtRisk,
    totalRealizedPnl: bundle.totalRealizedPnl,
    medianPositionRoi: bundle.medianPositionRoi,
    outcomeWinRate: bundle.outcomeWinRate,
    resolvedVolumeUsd: bundle.resolvedVolumeUsd,
    avgEv: bundle.avgEv,
  };
}

export function computeWalletLedgerMetrics(
  input: ComputeWalletLedgerMetricsInput
): WalletLedgerMetrics {
  const resolutionCoverage = computeResolutionCoverage(input.positions);
  const validity = assessWalletLedgerValidity({
    positions: input.positions,
    identity: input.identity,
    activityTruncated: input.activityTruncated,
    tradesTruncated: input.tradesTruncated,
    resolutionCoverage,
    mergeSplit: input.mergeSplit,
    hasHistoryEvents: input.hasHistoryEvents,
    historicalBackfillRequired: input.historicalBackfillRequired,
    unresolvedChainOrderBlocksCredibility:
      input.unresolvedChainOrderBlocksCredibility,
    unresolvedChainEvents: input.unresolvedChainEvents,
    unresolvedChainEventsInLifecycle: input.unresolvedChainEventsInLifecycle,
    affectedPositionGroups: input.affectedPositionGroups,
  });

  const openPositionCount = input.positions.filter((p) => !p.completed).length;
  const excludedPositionCount = input.positions.filter(
    (p) => p.excludedFromMetrics
  ).length;
  const fullyExitedPositionCount = input.positions.filter(
    (p) => p.fullyExited
  ).length;
  const heldThroughResolutionPositionCount = input.positions.filter(
    (p) => p.heldThroughResolution
  ).length;

  const primaryBundle =
    validity.credibilityMetrics ?? validity.observedWindowMetrics;

  return {
    ...bundleToTopLevel(primaryBundle),
    historyComplete: validity.historyComplete,
    metricValidity: validity.metricValidity,
    credibilityMetricsValid: validity.credibilityMetricsValid,
    historyValidity: validity.historyValidity,
    activityTruncated: input.activityTruncated,
    tradesTruncated: input.tradesTruncated,
    identityConfidence: input.identity.confidence,
    excludedPositionCount,
    historyCompletenessReasons: validity.historyCompletenessReasons,
    openPositionCount,
    distinctPositionCount: input.positions.length,
    fullyExitedPositionCount,
    heldThroughResolutionPositionCount,
    rawEventCount: input.rawEventCount,
    deduplicatedEventCount: input.deduplicatedEventCount,
    observedWindowMetrics: validity.observedWindowMetrics,
    credibilityMetrics: validity.credibilityMetrics,
    resolutionCoverage: validity.resolutionCoverage,
    gammaCoverage: input.gammaCoverage,
    mergeSplit: {
      positionsWithMergeSplit: input.mergeSplit.positionsWithMergeSplit,
      pctCompletedPositionsAffected: input.mergeSplit.pctCompletedPositionsAffected,
      grossCashAffected: input.mergeSplit.grossCashAffected,
      potentialCapitalAtRiskAffected: input.mergeSplit.potentialCapitalAtRiskAffected,
      safeDespiteMergeSplit: input.mergeSplit.safeDespiteMergeSplit,
      ambiguousMergeSplit: input.mergeSplit.ambiguousMergeSplit,
      pctAmbiguousOfCompleted: input.mergeSplit.pctAmbiguousOfCompleted,
      recommendation: input.mergeSplit.recommendation,
    },
  };
}
