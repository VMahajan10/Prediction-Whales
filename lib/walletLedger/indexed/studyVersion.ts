/**
 * Phase 2E.2 calibration study versioning — separate from ledger/metric versions.
 */

export const STAGE_C_STUDY_VERSION = "phase2e2-stageC-v1" as const;
export const STAGE_C_BATCH_ID = STAGE_C_STUDY_VERSION;

/** Candidate contract revision under calibration (shadow-only). */
export const STAGE_C_CONTRACT_VERSION =
  "credibility-metric-contract-v2-stageC" as const;

export const STAGE_C_COHORT_MANIFEST = "phase2e2-stageC-cohort.json" as const;
export const STAGE_C_ANALYSIS_JSON = "phase2e2-stageC-analysis.json" as const;
export const STAGE_C_ANALYSIS_MD = "phase2e2-stageC-analysis.md" as const;
