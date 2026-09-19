#!/usr/bin/env tsx
/**
 * Recover durable shadow observations and regenerate reports without rerunning audits.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "./preload-env";
import { productionGateLabel } from "@/lib/walletLedger/indexed/shadow/productionReconciliation";
import {
  buildValidationOverlapReport,
  loadCohortSpecs,
  observationsToComparisonRows,
  recoverBatchShadowObservations,
} from "@/lib/walletLedger/indexed/shadow/shadowResultRecovery";
import {
  categorizeShadowWalletOutcome,
  summarizeShadowBatch,
  writeShadowReports,
} from "@/lib/walletLedger/indexed/shadow/report";
import type { ShadowWalletComparison } from "@/lib/walletLedger/indexed/shadow/taxonomy";

const batchId = process.argv[2] ?? "phase2e1-full50-v2";
const validationBatchId = "phase2e1-validation20";
const outDir = join(process.cwd(), "tmp", "wallet-history", "shadow-compare");

function backupExisting(path: string): void {
  if (!existsSync(path)) return;
  const backupPath = path.replace(/(\.[^.]+)$/, "-pre-reconcile$1");
  if (!existsSync(backupPath)) {
    copyFileSync(path, backupPath);
  }
}

function topDisagreementReasons(
  rows: ShadowWalletComparison[],
  limit = 10
): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows.filter((r) => r.status === "complete")) {
    for (const reason of row.productionReasons) {
      counts.set(`production:${reason}`, (counts.get(`production:${reason}`) ?? 0) + 1);
    }
    for (const reason of row.apiReasons) {
      counts.set(`api:${reason}`, (counts.get(`api:${reason}`) ?? 0) + 1);
    }
    for (const reason of row.reasons) {
      counts.set(`indexed:${reason}`, (counts.get(`indexed:${reason}`) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

async function main(): Promise<void> {
  const cohort = loadCohortSpecs(batchId);
  const observations = await recoverBatchShadowObservations(batchId, { persist: true });
  const rows = observationsToComparisonRows(observations);

  const summary = summarizeShadowBatch({
    batchId,
    cohort,
    rows,
    batchComplete: true,
    infraInterrupted: false,
  });

  backupExisting(join(outDir, `shadow-${batchId}.json`));
  backupExisting(join(outDir, `shadow-${batchId}.md`));
  const reportPaths = writeShadowReports({
    batchId,
    rows,
    summary,
    cohort,
  });

  const failWallets = cohort.filter((w) => w.productionGate === "fail");
  const rowByWallet = new Map(rows.map((row) => [row.wallet.toLowerCase(), row]));
  const observationByWallet = new Map(
    observations.map((observation) => [observation.wallet.toLowerCase(), observation])
  );

  const productionFailBreakdown = failWallets.map((spec) => {
    const wallet = spec.wallet.toLowerCase();
    const row = rowByWallet.get(wallet);
    const observation = observationByWallet.get(wallet);
    const outcome = categorizeShadowWalletOutcome(row);
    const productionSnapshot = observation?.productionMetricsSnapshot ?? {};
    const indexedSnapshot = observation?.indexedMetricsSnapshot ?? {};
    return {
      wallet: spec.wallet,
      cohortProductionDecision: productionGateLabel(spec.productionGate),
      cohortProductionReason: spec.productionFailureReason ?? "unknown",
      batchStatus: row?.status ?? "not_attempted",
      outcomeCategory: outcome,
      metricsSafe: outcome === "metrics-safe",
      metricsUnsafe: outcome === "metrics-unsafe",
      unusable: outcome === "unusable",
      historyValidity: row?.historyValidity ?? "n/a",
      credibilityMetricsValid: row?.credibilityMetricsValid ?? false,
      A: row?.productionDecision ?? null,
      ASource: observation?.productionObservationSource ?? "comparison_metadata_missing",
      B: row?.apiReconstructedDecision ?? null,
      BSource: observation?.apiObservationSource ?? "comparison_metadata_missing",
      C: row?.indexedDecision ?? false,
      CSource: observation?.indexedObservationSource ?? "comparison_metadata_missing",
      productionResolvedBets: productionSnapshot.productionResolvedPositions ?? null,
      indexedCompletedPositions: indexedSnapshot.indexedCompletedPositions ?? null,
      productionAvgEv: productionSnapshot.productionAvgEv ?? null,
      indexedRealizedRoi: indexedSnapshot.indexedRealizedRoi ?? null,
      indexedProfitablePositionRate: indexedSnapshot.profitablePositionRate ?? null,
      productionStakeVolume: productionSnapshot.avgStakeNotional ?? null,
      indexedCapitalAtRisk: indexedSnapshot.medianCapitalAtRisk ?? null,
      indexedResolvedVolumeUsd: indexedSnapshot.resolvedVolumeUsd ?? null,
      indexedReasons: row?.reasons ?? [],
      comparisonMetadataMissing: observation?.comparisonMetadataMissing ?? false,
    };
  });

  let validationOverlap: ReturnType<typeof buildValidationOverlapReport> = [];
  try {
    const validationObservations = await recoverBatchShadowObservations(
      validationBatchId,
      { persist: true, fallbackCohort: cohort }
    );
    validationOverlap = buildValidationOverlapReport(validationObservations, observations);
  } catch (error) {
    console.error(
      `[reconcile-shadow-report] validation20 overlap skipped: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const metadataMissing = observations.filter((row) => row.comparisonMetadataMissing);
  const apiMissing = observations.filter(
    (row) =>
      row.executionStatus === "complete" &&
      row.apiObservationSource === "comparison_metadata_missing"
  );

  const corrected = {
    batchId,
    evidenceValid: summary.metricsSafe > 0 && metadataMissing.length === 0,
    metadataMissingCount: metadataMissing.length,
    apiMetadataMissingCount: apiMissing.length,
    cohort: {
      selected: summary.cohortSelected,
      productionPass: summary.cohortProductionPass,
      productionFail: summary.cohortProductionFail,
      productionUnknown: summary.cohortProductionUnknown,
    },
    outcomes: {
      evaluated: summary.walletsEvaluated,
      metricsSafe: summary.metricsSafe,
      metricsUnsafe: summary.metricsUnsafe,
      unusable: summary.unusableValidity,
      infraFailed: summary.infraFailed,
      walletFailed: summary.walletFailed,
      deferredInfra: summary.deferredInfra,
      pending: summary.pending,
    },
    metricsSafeProduction: {
      pass: summary.productionPass,
      fail: summary.productionFail,
      unknown: summary.productionUnknown,
    },
    productionVsIndexed: {
      nKnown: summary.productionVsIndexed.nKnown,
      passToPass: summary.productionVsIndexed.passToPass,
      passToFail: summary.productionVsIndexed.passToFail,
      failToPass: summary.productionVsIndexed.failToPass,
      failToFail: summary.productionVsIndexed.failToFail,
      nUnknown: summary.productionVsIndexed.nUnknown,
      nullToPass: summary.productionVsIndexed.nullToPass,
      nullToFail: summary.productionVsIndexed.nullToFail,
      nMetricsSafeTotal: summary.productionVsIndexed.nMetricsSafeTotal,
    },
    apiVsIndexed: {
      nApiComparable: summary.apiVsIndexed.nKnown,
      passToPass: summary.apiVsIndexed.passToPass,
      passToFail: summary.apiVsIndexed.passToFail,
      failToPass: summary.apiVsIndexed.failToPass,
      failToFail: summary.apiVsIndexed.failToFail,
      missingB: apiMissing.map((row) => row.wallet),
    },
    productionFailWallets: productionFailBreakdown,
    validation20Overlap: validationOverlap,
    topDisagreementReasons: topDisagreementReasons(rows),
    rootCause:
      "Resume merge in batchRunner rebuilt skipped wallets without A/B/C; observations now recovered from pre-reconcile artifact, batch performance.shadowDecisions, cohort gate snapshot, and persisted indexed metrics.",
  };

  const reconciledPath = join(outDir, `shadow-${batchId}-reconciliation.json`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(reconciledPath, JSON.stringify(corrected, null, 2));

  console.log(
    JSON.stringify(
      {
        reportPaths,
        reconciliationPath: reconciledPath,
        corrected,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error("[reconcile-shadow-report] failed:", error);
  process.exit(1);
});
