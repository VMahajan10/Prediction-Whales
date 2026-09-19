/**
 * Phase 2E.2 Stage B — component-based indexed credibility candidate evaluator.
 * Shadow-only. Does not persist to production or replace canonical C decisions.
 */

export const CREDIBILITY_CONTRACT_V2_STAGE_B = "credibility-metric-contract-v2-stageB" as const;
export const CREDIBILITY_CONTRACT_V2_STAGE_C = "credibility-metric-contract-v2-stageC" as const;

export const STAGE_B_EXPERIENCE_FLOOR = 10;
export const STAGE_C_EXPERIENCE_FLOOR = 10;

export type ComponentVerdict = "PASS" | "FAIL" | "UNKNOWN" | "NOT_USED";

export interface IndexedCredibilityCandidateMetrics {
  indexedDataValidity: boolean;
  completedPositionCount: number;
  portfolioRealizedRoi?: number | null;
  profitablePositionRate?: number | null;
}

export interface IndexedCredibilityCandidateV2 {
  dataValidity: ComponentVerdict;
  historicalEvidence: ComponentVerdict;
  historicalPerformance: ComponentVerdict;
  capitalQualification: ComponentVerdict;
  overallDecision: ComponentVerdict;
  reasons: string[];
  contractVersion: string;
}

export interface EvaluateIndexedCredibilityCandidateV2Options {
  historicalPerformance?: ComponentVerdict;
  capitalQualification?: ComponentVerdict;
  experienceFloor?: number;
}

export function evaluateIndexedCredibilityCandidateV2(
  metrics: IndexedCredibilityCandidateMetrics,
  options: EvaluateIndexedCredibilityCandidateV2Options = {}
): IndexedCredibilityCandidateV2 {
  const reasons: string[] = [];
  const experienceFloor = options.experienceFloor ?? STAGE_B_EXPERIENCE_FLOOR;
  const capitalQualification = options.capitalQualification ?? "NOT_USED";

  const dataValidity: ComponentVerdict = metrics.indexedDataValidity
    ? "PASS"
    : "FAIL";
  if (dataValidity === "FAIL") {
    reasons.push("indexed_data_validity_failed");
  }

  let historicalEvidence: ComponentVerdict;
  if (dataValidity === "FAIL") {
    historicalEvidence = "UNKNOWN";
    reasons.push("historical_evidence_skipped_data_invalid");
  } else if (metrics.completedPositionCount >= experienceFloor) {
    historicalEvidence = "PASS";
  } else {
    historicalEvidence = "FAIL";
    reasons.push(
      `completed_position_count_${metrics.completedPositionCount}_below_floor_${experienceFloor}`
    );
  }

  const historicalPerformance =
    options.historicalPerformance ?? ("UNKNOWN" as ComponentVerdict);
  if (historicalPerformance === "UNKNOWN") {
    reasons.push("historical_performance_policy_unresolved");
  }

  if (capitalQualification === "FAIL") {
    reasons.push("capital_qualification_failed");
  }

  const overallDecision = deriveOverallDecision({
    dataValidity,
    historicalEvidence,
    historicalPerformance,
    capitalQualification,
    reasons,
  });

  return {
    dataValidity,
    historicalEvidence,
    historicalPerformance,
    capitalQualification,
    overallDecision,
    reasons,
    contractVersion: CREDIBILITY_CONTRACT_V2_STAGE_B,
  };
}

function deriveOverallDecision(input: {
  dataValidity: ComponentVerdict;
  historicalEvidence: ComponentVerdict;
  historicalPerformance: ComponentVerdict;
  capitalQualification: ComponentVerdict;
  reasons: string[];
}): ComponentVerdict {
  if (input.dataValidity === "FAIL") return "FAIL";
  if (input.historicalEvidence === "FAIL") return "FAIL";
  if (input.historicalPerformance === "FAIL") return "FAIL";
  if (input.historicalPerformance === "UNKNOWN") return "UNKNOWN";
  if (
    input.capitalQualification !== "NOT_USED" &&
    input.capitalQualification === "FAIL"
  ) {
    return "FAIL";
  }
  if (
    input.dataValidity === "PASS" &&
    input.historicalEvidence === "PASS" &&
    input.historicalPerformance === "PASS" &&
    (input.capitalQualification === "NOT_USED" ||
      input.capitalQualification === "PASS")
  ) {
    return "PASS";
  }
  input.reasons.push("overall_decision_unresolved");
  return "UNKNOWN";
}

export type PerformanceExplorationPolicy =
  | { kind: "roi_gt"; threshold: number; label: string }
  | { kind: "roi_gte"; threshold: number; label: string }
  | { kind: "rate_gte"; threshold: number; label: string }
  | {
      kind: "roi_gt_and_rate_gte";
      roiThreshold: number;
      rateThreshold: number;
      label: string;
    }
  | {
      kind: "roi_gte_and_rate_gte";
      roiThreshold: number;
      rateThreshold: number;
      label: string;
    };

export const STAGE_B_EXPLORATORY_PERFORMANCE_POLICIES: PerformanceExplorationPolicy[] =
  [
    { kind: "roi_gt", threshold: 0, label: "ROI > 0" },
    { kind: "roi_gte", threshold: 0.03, label: "ROI >= 0.03" },
    { kind: "roi_gte", threshold: 0.05, label: "ROI >= 0.05" },
    { kind: "rate_gte", threshold: 0.4, label: "profitablePositionRate >= 0.40" },
    { kind: "rate_gte", threshold: 0.5, label: "profitablePositionRate >= 0.50" },
    { kind: "rate_gte", threshold: 0.6, label: "profitablePositionRate >= 0.60" },
    {
      kind: "roi_gt_and_rate_gte",
      roiThreshold: 0,
      rateThreshold: 0.5,
      label: "ROI > 0 AND profitablePositionRate >= 0.50",
    },
  ];

/** Stage C expanded policy matrix (exploratory only — not production). */
export const STAGE_C_EXPLORATORY_PERFORMANCE_POLICIES: PerformanceExplorationPolicy[] =
  [
    { kind: "roi_gt", threshold: 0, label: "portfolioRealizedRoi > 0" },
    { kind: "roi_gte", threshold: 0.03, label: "portfolioRealizedRoi >= 0.03" },
    { kind: "roi_gte", threshold: 0.05, label: "portfolioRealizedRoi >= 0.05" },
    {
      kind: "rate_gte",
      threshold: 0.4,
      label: "profitablePositionRate >= 0.40",
    },
    {
      kind: "rate_gte",
      threshold: 0.5,
      label: "profitablePositionRate >= 0.50",
    },
    {
      kind: "rate_gte",
      threshold: 0.6,
      label: "profitablePositionRate >= 0.60",
    },
    {
      kind: "roi_gt_and_rate_gte",
      roiThreshold: 0,
      rateThreshold: 0.4,
      label: "ROI > 0 AND profitablePositionRate >= 0.40",
    },
    {
      kind: "roi_gt_and_rate_gte",
      roiThreshold: 0,
      rateThreshold: 0.5,
      label: "ROI > 0 AND profitablePositionRate >= 0.50",
    },
    {
      kind: "roi_gte_and_rate_gte",
      roiThreshold: 0.03,
      rateThreshold: 0.4,
      label: "ROI >= 0.03 AND profitablePositionRate >= 0.40",
    },
    {
      kind: "roi_gte_and_rate_gte",
      roiThreshold: 0.03,
      rateThreshold: 0.5,
      label: "ROI >= 0.03 AND profitablePositionRate >= 0.50",
    },
  ];

export const STAGE_C_EXPERIENCE_FLOORS = [10, 20, 50] as const;

export function performanceVerdictFromPolicy(input: {
  portfolioRealizedRoi: number | null | undefined;
  profitablePositionRate: number | null | undefined;
  policy: PerformanceExplorationPolicy;
}): ComponentVerdict {
  const roi = input.portfolioRealizedRoi;
  const rate = input.profitablePositionRate;
  switch (input.policy.kind) {
    case "roi_gt":
      return roi != null && Number.isFinite(roi) && roi > input.policy.threshold
        ? "PASS"
        : "FAIL";
    case "roi_gte":
      return roi != null &&
        Number.isFinite(roi) &&
        roi >= input.policy.threshold
        ? "PASS"
        : "FAIL";
    case "rate_gte":
      return rate != null &&
        Number.isFinite(rate) &&
        rate >= input.policy.threshold
        ? "PASS"
        : "FAIL";
    case "roi_gt_and_rate_gte":
      return roi != null &&
        Number.isFinite(roi) &&
        roi > input.policy.roiThreshold &&
        rate != null &&
        Number.isFinite(rate) &&
        rate >= input.policy.rateThreshold
        ? "PASS"
        : "FAIL";
    case "roi_gte_and_rate_gte":
      return roi != null &&
        Number.isFinite(roi) &&
        roi >= input.policy.roiThreshold &&
        rate != null &&
        Number.isFinite(rate) &&
        rate >= input.policy.rateThreshold
        ? "PASS"
        : "FAIL";
    default:
      return "UNKNOWN";
  }
}
