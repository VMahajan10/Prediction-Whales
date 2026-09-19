/**
 * Phase 2E.2 — Indexed credibility metric contract (semantic layer only).
 *
 * Preserves legacy DB/report field names (`indexedDecision`, `credibilityDecision`)
 * while making the four shadow comparators explicit.
 *
 * C semantics are unchanged: structural data validity only.
 * D is defined here as a candidate contract; not implemented as a live gate.
 */

/** A — Production numeric credibility gate (`whale_registry` + hydration). */
export type ProductionCredibilityDecision = boolean | null;

/** B — API-reconstructed legacy diagnostic comparator (truncated public history). */
export type ApiReconstructedDecision = boolean | null;

/**
 * C — Indexed structural / data-quality validity.
 * Legacy storage: `indexedDecision`, `credibilityDecision`, `credibilityMetricsValid`.
 */
export type IndexedDataValidityDecision = boolean;

/** D — Phase 2E.2 candidate indexed credibility (not yet implemented). */
export type IndexedCredibilityCandidateDecision = boolean;

export const CREDIBILITY_CONTRACT_V2_ID = "credibility-metric-contract-v2" as const;

/** Shadow-only Policy A — resolved Stage C historical performance gate. */
export const HISTORICAL_PERFORMANCE_POLICY_VERSION =
  "historical-performance-policy-a-v1" as const;

export interface HistoricalPerformancePolicy {
  id: "policy_a_reference";
  metricVersion: string;
  minimumCompletedPositions: number;
  /** Strict inequality: realized ROI must be greater than this value. */
  minimumRealizedRoiExclusive: number;
  minimumProfitablePositionRate: number;
  label: string;
}

export const HISTORICAL_PERFORMANCE_POLICY_A: HistoricalPerformancePolicy = {
  id: "policy_a_reference",
  metricVersion: "phase2e1-v1",
  minimumCompletedPositions: 10,
  minimumRealizedRoiExclusive: 0,
  minimumProfitablePositionRate: 0.5,
  label:
    "completed positions >= 10 AND realized ROI > 0 AND profitable position rate >= 50%",
};

/** @deprecated use HISTORICAL_PERFORMANCE_POLICY_A */
export const historicalPerformancePolicy = HISTORICAL_PERFORMANCE_POLICY_A;

export type HistoricalPerformanceFailureReason =
  | "below_completed_position_floor"
  | "non_positive_realized_roi"
  | "below_profitable_position_rate"
  | "multiple_performance_failures"
  | "historical_metrics_unavailable"
  | "indexed_data_invalid";

export const SEMANTIC_ALIASES = {
  A: "productionCredibilityDecision",
  B: "apiReconstructedDecision",
  C: "indexedDataValidityDecision",
  D: "indexedCredibilityCandidateDecision",
} as const;

/** Map persisted shadow row field → semantic name for reports. */
export function indexedDataValidityFromRow(row: {
  indexedDecision?: boolean;
  credibilityMetricsValid?: boolean;
}): IndexedDataValidityDecision {
  return Boolean(row.indexedDecision ?? row.credibilityMetricsValid);
}

/** Whether indexed history supports metric computation (execution outcome label). */
export function isIndexedMetricsSafe(input: {
  historyValidity?: string;
  status?: string;
}): boolean {
  if (input.status === "complete") return true;
  return (
    input.historyValidity === "partial-but-metrics-safe" ||
    input.historyValidity === "complete"
  );
}

/**
 * Layer 1 of candidate D — must pass before numeric credibility evaluation.
 * Equivalent to current C; semantics intentionally unchanged.
 */
export function layer1IndexedDataValidity(
  indexedDataValidity: IndexedDataValidityDecision
): boolean {
  return indexedDataValidity === true;
}

/**
 * Layer 2 candidate experience floor (observational / Stage B candidate).
 * See `credibilityCandidateV2.ts` for component evaluator.
 */
export const CANDIDATE_EXPERIENCE_FLOOR = 10;

export type { ComponentVerdict, IndexedCredibilityCandidateV2 } from "@/lib/walletLedger/indexed/credibilityCandidateV2";
export {
  evaluateIndexedCredibilityCandidateV2,
  STAGE_B_EXPERIENCE_FLOOR,
} from "@/lib/walletLedger/indexed/credibilityCandidateV2";
export {
  evaluateHistoricalPerformanceVerdict,
  enrichShadowWalletWithHistoricalPerformance,
  hydrateShadowRowsWithHistoricalPerformance,
  type HistoricalPerformanceDecision,
  type HistoricalPerformanceVerdictResult,
  type IndexedDataValidityVerdict,
} from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";

export interface IndexedCredibilityCandidateLayers {
  layer1_dataValidity: boolean;
  layer2_sufficientHistoricalEvidence: boolean | null;
  layer2_historicalPerformanceQualification: boolean | null;
  layer2_capitalVolumeQualification: boolean | null;
}

/**
 * Shadow-only observational evaluator for sensitivity analysis.
 * Does NOT persist or replace canonical indexed decisions.
 */
export function observationalExperienceFloorDecision(input: {
  indexedDataValidity: boolean;
  completedPositionCount: number;
  floor: number;
}): boolean {
  return (
    input.indexedDataValidity && input.completedPositionCount >= input.floor
  );
}
