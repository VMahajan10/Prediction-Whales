/**
 * Shadow-only historical performance verdict (Policy A).
 * Separate from indexed data validity — does not affect production gates.
 */

import {
  HISTORICAL_PERFORMANCE_POLICY_A,
  HISTORICAL_PERFORMANCE_POLICY_VERSION,
  type HistoricalPerformanceFailureReason,
  type HistoricalPerformancePolicy,
} from "@/lib/walletLedger/indexed/credibilityContractV2";
import type { ShadowWalletComparison } from "@/lib/walletLedger/indexed/shadow/taxonomy";

export type HistoricalPerformanceDecision = "PASS" | "FAIL" | "UNKNOWN";
export type IndexedDataValidityVerdict = "PASS" | "FAIL";

export interface HistoricalPerformanceVerdictInput {
  indexedDataValidity: boolean;
  historyComplete?: boolean;
  historyValidity?: string | null;
  completedPositionCount: number | null | undefined;
  realizedRoi: number | null | undefined;
  profitablePositionRate: number | null | undefined;
  metricVersion?: string | null;
  policy?: HistoricalPerformancePolicy;
}

export interface HistoricalPerformanceVerdictResult {
  indexedDataValidityDecision: IndexedDataValidityVerdict;
  historicalPerformanceDecision: HistoricalPerformanceDecision;
  historicalPerformanceFailureReasons: HistoricalPerformanceFailureReason[];
  historicalPerformancePolicyVersion: string;
}

function isMetricsUnavailable(input: HistoricalPerformanceVerdictInput): boolean {
  const roi = input.realizedRoi;
  const rate = input.profitablePositionRate;
  const count = input.completedPositionCount;
  return (
    count == null ||
    !Number.isFinite(count) ||
    roi == null ||
    !Number.isFinite(roi) ||
    rate == null ||
    !Number.isFinite(rate)
  );
}

function isHistoricalCoverageIncomplete(
  input: HistoricalPerformanceVerdictInput
): boolean {
  const validity = input.historyValidity;
  return (
    validity === "unusable" ||
    validity === "partial-and-metrics-unsafe" ||
    validity === "incomplete"
  );
}

/** Sub-threshold samples from uncertified history cannot yield definitive PASS/FAIL. */
function lacksTrustworthyPerformanceSample(
  input: HistoricalPerformanceVerdictInput,
  policy: HistoricalPerformancePolicy
): boolean {
  const count = input.completedPositionCount ?? 0;
  if (count >= policy.minimumCompletedPositions) return false;
  return input.historyComplete === false || input.historyValidity !== "complete";
}

function collectPerformanceFailures(
  input: HistoricalPerformanceVerdictInput,
  policy: HistoricalPerformancePolicy
): HistoricalPerformanceFailureReason[] {
  const failures: HistoricalPerformanceFailureReason[] = [];
  const count = input.completedPositionCount ?? 0;
  const roi = input.realizedRoi!;
  const rate = input.profitablePositionRate!;

  if (count < policy.minimumCompletedPositions) {
    failures.push("below_completed_position_floor");
  }
  if (roi <= policy.minimumRealizedRoiExclusive) {
    failures.push("non_positive_realized_roi");
  }
  if (rate < policy.minimumProfitablePositionRate) {
    failures.push("below_profitable_position_rate");
  }
  return failures;
}

function collapsePerformanceFailures(
  failures: HistoricalPerformanceFailureReason[]
): HistoricalPerformanceFailureReason[] {
  const performanceOnly = failures.filter(
    (reason) =>
      reason !== "historical_metrics_unavailable" &&
      reason !== "indexed_data_invalid"
  );
  if (performanceOnly.length === 0) return [];
  if (performanceOnly.length === 1) return performanceOnly;
  return ["multiple_performance_failures"];
}

export function evaluateHistoricalPerformanceVerdict(
  input: HistoricalPerformanceVerdictInput
): HistoricalPerformanceVerdictResult {
  const policy = input.policy ?? HISTORICAL_PERFORMANCE_POLICY_A;
  const indexedDataValidityDecision: IndexedDataValidityVerdict =
    input.indexedDataValidity ? "PASS" : "FAIL";

  if (!input.indexedDataValidity) {
    return {
      indexedDataValidityDecision,
      historicalPerformanceDecision: "UNKNOWN",
      historicalPerformanceFailureReasons: ["indexed_data_invalid"],
      historicalPerformancePolicyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
    };
  }

  if (isHistoricalCoverageIncomplete(input)) {
    return {
      indexedDataValidityDecision,
      historicalPerformanceDecision: "UNKNOWN",
      historicalPerformanceFailureReasons: ["indexed_data_invalid"],
      historicalPerformancePolicyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
    };
  }

  if (
    input.metricVersion != null &&
    input.metricVersion !== policy.metricVersion
  ) {
    return {
      indexedDataValidityDecision,
      historicalPerformanceDecision: "UNKNOWN",
      historicalPerformanceFailureReasons: ["historical_metrics_unavailable"],
      historicalPerformancePolicyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
    };
  }

  if (isMetricsUnavailable(input)) {
    return {
      indexedDataValidityDecision,
      historicalPerformanceDecision: "UNKNOWN",
      historicalPerformanceFailureReasons: ["historical_metrics_unavailable"],
      historicalPerformancePolicyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
    };
  }

  if (lacksTrustworthyPerformanceSample(input, policy)) {
    return {
      indexedDataValidityDecision,
      historicalPerformanceDecision: "UNKNOWN",
      historicalPerformanceFailureReasons: ["historical_metrics_unavailable"],
      historicalPerformancePolicyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
    };
  }

  const performanceFailures = collectPerformanceFailures(input, policy);
  if (performanceFailures.length === 0) {
    return {
      indexedDataValidityDecision,
      historicalPerformanceDecision: "PASS",
      historicalPerformanceFailureReasons: [],
      historicalPerformancePolicyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
    };
  }

  return {
    indexedDataValidityDecision,
    historicalPerformanceDecision: "FAIL",
    historicalPerformanceFailureReasons: collapsePerformanceFailures(
      performanceFailures
    ),
    historicalPerformancePolicyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
  };
}

export function historicalPerformanceInputFromShadowRow(
  row: ShadowWalletComparison,
  metrics?: {
    completedPositions?: number | null;
    realizedRoi?: number | null;
    profitablePositionRate?: number | null;
    metricVersion?: string | null;
  }
): HistoricalPerformanceVerdictInput {
  const completedPositionCount =
    metrics?.completedPositions ??
    (row.evidence.indexedCompletedPositions as number | null | undefined) ??
    null;
  const realizedRoi =
    metrics?.realizedRoi ??
    (row.evidence.indexedRealizedRoi as number | null | undefined) ??
    null;
  const profitablePositionRate =
    metrics?.profitablePositionRate ??
    (row.evidence.indexedProfitablePositionRate as number | null | undefined) ??
    null;

  return {
    indexedDataValidity: Boolean(row.indexedDecision ?? row.credibilityMetricsValid),
    historyComplete: row.historyComplete,
    historyValidity: row.historyValidity,
    completedPositionCount,
    realizedRoi,
    profitablePositionRate,
    metricVersion: metrics?.metricVersion ?? null,
  };
}

export function enrichShadowWalletWithHistoricalPerformance(
  row: ShadowWalletComparison,
  metrics?: {
    completedPositions?: number | null;
    realizedRoi?: number | null;
    profitablePositionRate?: number | null;
    metricVersion?: string | null;
  }
): ShadowWalletComparison {
  const verdict = evaluateHistoricalPerformanceVerdict(
    historicalPerformanceInputFromShadowRow(row, metrics)
  );
  return {
    ...row,
    indexedDataValidityDecision: verdict.indexedDataValidityDecision,
    historicalPerformanceDecision: verdict.historicalPerformanceDecision,
    historicalPerformanceFailureReasons:
      verdict.historicalPerformanceFailureReasons,
    historicalPerformancePolicyVersion: verdict.historicalPerformancePolicyVersion,
    evidence: {
      ...row.evidence,
      indexedDataValidityDecision: verdict.indexedDataValidityDecision,
      historicalPerformanceDecision: verdict.historicalPerformanceDecision,
      historicalPerformanceFailureReasons:
        verdict.historicalPerformanceFailureReasons,
      historicalPerformancePolicyVersion: verdict.historicalPerformancePolicyVersion,
      indexedProfitablePositionRate:
        metrics?.profitablePositionRate ??
        (row.evidence.indexedProfitablePositionRate as number | null | undefined) ??
        profitablePositionRateFromRow(row),
    },
  };
}

function profitablePositionRateFromRow(
  row: ShadowWalletComparison
): number | null {
  const fromEvidence = row.evidence.indexedProfitablePositionRate;
  return typeof fromEvidence === "number" ? fromEvidence : null;
}

export interface PolicyAMetricsSnapshot {
  credibilityMetricsValid: boolean | null;
  historyValidity: string | null;
  historyComplete?: boolean | null;
  completedPositions: number | null;
  realizedRoi: number | null;
  profitablePositionRate: number | null;
  metricVersion: string | null;
  historyIncompleteReasons?: string[] | null;
}

export function hasDefinitivePolicyAVerdict(
  metrics: PolicyAMetricsSnapshot | null | undefined,
  historyIncompleteReasons?: string[] | null
): boolean {
  if (!metrics) return false;
  if (
    historyIncompleteReasons?.includes("derived_state_uncommitted") ||
    historyIncompleteReasons?.includes("baseline_incomplete")
  ) {
    return false;
  }
  const verdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: Boolean(metrics.credibilityMetricsValid),
    historyValidity: metrics.historyValidity,
    historyComplete: metrics.historyComplete ?? undefined,
    completedPositionCount: metrics.completedPositions,
    realizedRoi: metrics.realizedRoi,
    profitablePositionRate: metrics.profitablePositionRate,
    metricVersion: metrics.metricVersion,
  });
  return (
    verdict.historicalPerformanceDecision === "PASS" ||
    verdict.historicalPerformanceDecision === "FAIL"
  );
}

export function isDurableHistoricalPerformanceEligible(
  row: ShadowWalletComparison
): boolean {
  if (row.status !== "complete") return false;
  if (!row.indexedDecision && !row.credibilityMetricsValid) return false;
  const completed = Number(row.evidence.indexedCompletedPositions ?? 0);
  return completed >= HISTORICAL_PERFORMANCE_POLICY_A.minimumCompletedPositions;
}

export function historicalPerformancePass(
  row: ShadowWalletComparison
): boolean {
  return row.historicalPerformanceDecision === "PASS";
}

export function hydrateShadowRowsWithHistoricalPerformance(
  rows: ShadowWalletComparison[],
  metricsByWallet?: Map<
    string,
    {
      completedPositions: number | null;
      realizedRoi: number | null;
      profitablePositionRate: number | null;
      metricVersion?: string | null;
    }
  >
): ShadowWalletComparison[] {
  return rows.map((row) => {
    const metrics = metricsByWallet?.get(row.wallet.toLowerCase());
    return enrichShadowWalletWithHistoricalPerformance(row, metrics ?? undefined);
  });
}
