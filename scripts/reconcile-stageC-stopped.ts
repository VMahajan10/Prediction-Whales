#!/usr/bin/env tsx
/**
 * Read-only Stage C stopped-run reconciliation for phase2e2-stageC-v1.
 */
import { readFileSync } from "node:fs";
import "./preload-env";
import { buildStageCInterimReport } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import { STAGE_C_COHORT_PATH } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

async function main(): Promise<void> {
  const cohort = JSON.parse(readFileSync(STAGE_C_COHORT_PATH, "utf8"));
  if (cohort.wallets?.length !== 220) {
    console.error(
      `WARN: cohort manifest has ${cohort.wallets?.length ?? 0} wallets, expected 220`
    );
  }

  const report = await buildStageCInterimReport({ batchId: STAGE_C_BATCH_ID });

  console.log(
    JSON.stringify(
      {
        batchId: STAGE_C_BATCH_ID,
        cohortSize: report.cohortSize,
        batchStatusBuckets: report.batchStatusBuckets,
        batchStatusSum: report.batchStatusSum,
        attempted: report.attempted,
        neverAttempted: report.neverAttempted,
        validityEvidence: report.validityEvidence,
        historicalPerformanceQualification:
          report.historicalPerformanceQualification,
        eligibilityTarget: report.eligibilityTarget,
        gapToTargetFloor10: report.gapToTargetFloor10,
        durableEligibleVerification: report.durableEligibleVerification,
        note:
          "batchStatusBuckets are mutually exclusive and sum to cohortSize. validityEvidence dimensions are separate observational counts and must not be summed with batchStatusBuckets.",
      },
      null,
      2
    )
  );
}

void main();
