#!/usr/bin/env tsx
/**
 * Phase 2E.1 shadow credibility comparison (read-only vs production).
 *
 * Stage A (default): 10-wallet smoke cohort
 * Stage B: validation20
 * Stage C (full50): ~50-wallet stratified cohort
 * Stage C calibration: phase2e2-stageC-v1 (~220-wallet expanded cohort)
 *
 *   npx tsx --tsconfig tsconfig.json scripts/shadow-credibility-compare.ts
 */
import "./preload-env";

import { runShadowCredibilityBatch } from "@/lib/walletLedger/indexed/shadow/batchRunner";
import { SMOKE_COHORT_10 } from "@/lib/walletLedger/indexed/shadow/cohort";

function parseArgs(argv: string[]): {
  stage: "smoke10" | "validation20" | "full50" | "stageC";
  concurrency: number;
  batchId?: string;
  noResume: boolean;
  dryRun: boolean;
  allowSmallCohort: boolean;
  schedulingPass: "full" | "passA" | "passB";
  invocationMaxWallets?: number;
  invocationMaxRuntimeMs?: number;
  invocationGracefulShutdownMs?: number;
  invocationForceShutdownMs?: number;
} {
  let stage: "smoke10" | "validation20" | "full50" | "stageC" = "smoke10";
  let concurrency = 2;
  let batchId: string | undefined;
  let noResume = false;
  let dryRun = false;
  let allowSmallCohort = false;
  let schedulingPass: "full" | "passA" | "passB" = "full";
  let invocationMaxWallets: number | undefined;
  let invocationMaxRuntimeMs: number | undefined;
  let invocationGracefulShutdownMs: number | undefined;
  let invocationForceShutdownMs: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--stage" && argv[i + 1]) {
      const value = argv[++i];
      if (
        value === "validation20" ||
        value === "full50" ||
        value === "smoke10" ||
        value === "stageC"
      ) {
        stage = value;
      }
    } else if (arg === "--concurrency" && argv[i + 1]) {
      concurrency = Number(argv[++i]);
    } else if (arg === "--batch-id" && argv[i + 1]) {
      batchId = argv[++i];
    } else if (arg === "--scheduling-pass" && argv[i + 1]) {
      const value = argv[++i];
      if (value === "full" || value === "passA" || value === "passB") {
        schedulingPass = value;
      }
    } else if (arg === "--invocation-max-wallets" && argv[i + 1]) {
      invocationMaxWallets = Number(argv[++i]);
    } else if (arg === "--invocation-max-runtime-ms" && argv[i + 1]) {
      invocationMaxRuntimeMs = Number(argv[++i]);
    } else if (arg === "--invocation-graceful-shutdown-ms" && argv[i + 1]) {
      invocationGracefulShutdownMs = Number(argv[++i]);
    } else if (arg === "--invocation-force-shutdown-ms" && argv[i + 1]) {
      invocationForceShutdownMs = Number(argv[++i]);
    } else if (arg === "--no-resume") {
      noResume = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--allow-small-cohort") {
      allowSmallCohort = true;
    }
  }
  return {
    stage,
    concurrency,
    batchId,
    noResume,
    dryRun,
    allowSmallCohort,
    schedulingPass,
    invocationMaxWallets,
    invocationMaxRuntimeMs,
    invocationGracefulShutdownMs,
    invocationForceShutdownMs,
  };
}

async function main(): Promise<void> {
  const {
    stage,
    concurrency,
    batchId,
    noResume,
    dryRun,
    allowSmallCohort,
    schedulingPass,
    invocationMaxWallets,
    invocationMaxRuntimeMs,
    invocationGracefulShutdownMs,
    invocationForceShutdownMs,
  } = parseArgs(process.argv.slice(2));

  console.error(
    `[shadow-compare] requestedStage=${stage} dryRun=${dryRun} schedulingPass=${schedulingPass}`
  );
  if (stage === "smoke10") {
    console.error(`[shadow-compare] smoke10 cohort size: ${SMOKE_COHORT_10.length}`);
  }

  const result = await runShadowCredibilityBatch({
    stage,
    walletConcurrency: concurrency,
    batchId,
    resume: !noResume,
    fullHistory: true,
    dryRun,
    allowSmallCohort,
    schedulingPass,
    invocationMaxWallets,
    invocationMaxRuntimeMs,
    invocationGracefulShutdownMs,
    invocationForceShutdownMs,
  });

  if (dryRun) {
    console.log(`\nDry run — no audits executed`);
    console.log(`Batch id: ${result.batchId}`);
    console.log(`Selected wallets: ${result.summary.cohortSelected}`);
    console.log(
      `PASS=${result.summary.cohortProductionPass} FAIL=${result.summary.cohortProductionFail} UNKNOWN=${result.summary.cohortProductionUnknown}`
    );
    return;
  }

  if (!result.reportPaths) {
    throw new Error("Expected report paths for non-dry-run batch");
  }

  console.log(`\nBatch: ${result.batchId}`);
  console.log(`JSON: ${result.reportPaths.jsonPath}`);
  console.log(`Report: ${result.reportPaths.mdPath}`);
  console.log(`\nSummary:`);
  console.log(`  cohortSelected=${result.summary.cohortSelected}`);
  console.log(`  evaluated=${result.summary.walletsEvaluated} metricsSafe=${result.summary.metricsSafe} infraFailed=${result.summary.infraFailed}`);
  console.log(
    `  metricsUnsafe=${result.summary.metricsUnsafe} unusable=${result.summary.unusableValidity} notAttempted=${result.summary.notAttempted}`
  );
  console.log(
    `  cohort production PASS/FAIL/unknown=${result.summary.cohortProductionPass}/${result.summary.cohortProductionFail}/${result.summary.cohortProductionUnknown}`
  );
  console.log(
    `  metrics-safe production PASS/FAIL/unknown=${result.summary.productionPass}/${result.summary.productionFail}/${result.summary.productionUnknown}`
  );
  console.log(
    `  api-reconstructed PASS/FAIL=${result.summary.apiPass}/${result.summary.apiFail}`
  );
  console.log(
    `  indexed PASS/FAIL=${result.summary.indexedPass}/${result.summary.indexedFail}`
  );
  const pvi = result.summary.productionVsIndexed;
  console.log(
    `  production→indexed (n=${result.summary.productionVsIndexedDenominator}) PASS→PASS=${pvi.passToPass} PASS→FAIL=${pvi.passToFail} FAIL→PASS=${pvi.failToPass} FAIL→FAIL=${pvi.failToFail} NULL→PASS=${pvi.nullToPass} NULL→FAIL=${pvi.nullToFail}`
  );
  const avi = result.summary.apiVsIndexed;
  console.log(
    `  api→indexed (n=${result.summary.apiVsIndexedDenominator}) PASS→PASS=${avi.passToPass} PASS→FAIL=${avi.passToFail} FAIL→PASS=${avi.failToPass} FAIL→FAIL=${avi.failToFail}`
  );
  if (result.integrity) {
    console.log(`\nDB integrity:`);
    console.log(
      `  events=${result.integrity.walletLedgerEvents} duplicate_dedupe_keys=${result.integrity.duplicateDedupeKeys}`
    );
    console.log(
      `  lifecycles=${result.integrity.walletPositionLifecycles} metrics=${result.integrity.walletHistoricalMetrics} coverage=${result.integrity.walletHistoryCoverage}`
    );
  }
}

void main().catch((error) => {
  console.error("[shadow-compare] failed:", error);
  process.exit(1);
});
