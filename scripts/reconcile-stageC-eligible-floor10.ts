#!/usr/bin/env tsx
/**
 * Read-only reconciliation for Stage C durable eligible floor>=10 count.
 */
import { readFileSync } from "node:fs";
import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletShadowBatchStatus,
} from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { observationalExperienceFloorDecision } from "@/lib/walletLedger/indexed/credibilityContractV2";
import {
  classifyMutuallyExclusiveBatchBucket,
  isDurableCalibrationEligible,
  isDurableStructurallyValid,
  type DurableCoverageRow,
  type DurableMetricsRow,
} from "@/lib/walletLedger/indexed/shadow/stageCReconciliation";
import { STAGE_C_COHORT_PATH } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

type EligibleWalletReport = {
  wallet: string;
  batchStatus: string;
  completedPositions: number | null;
  coverageState: {
    lastIndexedBlock: number | null;
    eventHistoryComplete: boolean | null;
    historyComplete: boolean | null;
    historyValidity: string | null;
  };
  metrics: {
    metricVersion: string | null;
    credibilityMetricsValid: boolean | null;
    credibilityDecision: boolean | null;
    historyValidity: string | null;
    historyComplete: boolean | null;
    throughBlock: number | null;
    calculatedAt: string | null;
  };
  structurallyValid: boolean;
  eligibleFloor10: boolean;
  reason: string;
};

function eligibilityReason(input: {
  batchStatus: string;
  structurallyValid: boolean;
  completedPositions: number;
}): string {
  if (input.batchStatus !== "complete") {
    return `batch_status_${input.batchStatus}`;
  }
  if (!input.structurallyValid) {
    return "not_structurally_valid";
  }
  const floorDecision = observationalExperienceFloorDecision({
    indexedDataValidity: true,
    completedPositionCount: input.completedPositions,
    floor: 10,
  });
  if (!floorDecision) {
    return `completed_positions_below_floor:${input.completedPositions}`;
  }
  return "eligible_floor10";
}

async function main(): Promise<void> {
  const cohort = JSON.parse(readFileSync(STAGE_C_COHORT_PATH, "utf8"));
  const wallets = cohort.wallets.map((w: { wallet: string }) =>
    w.wallet.toLowerCase()
  );
  const db = getDb();

  const statusRows = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(sql`${walletShadowBatchStatus.batchId} = ${STAGE_C_BATCH_ID}`);
  const metricsRows = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(sql`${walletHistoricalMetrics.walletAddress} IN ${wallets}`);
  const coverageRows = await db
    .select()
    .from(walletHistoryCoverage)
    .where(sql`${walletHistoryCoverage.walletAddress} IN ${wallets}`);

  const statusByWallet = new Map(
    statusRows.map((row) => [row.walletAddress.toLowerCase(), row])
  );
  const metricsByWallet = new Map(
    metricsRows.map((row) => [
      row.walletAddress.toLowerCase(),
      {
        walletAddress: row.walletAddress,
        completedPositions: row.completedPositions,
        credibilityMetricsValid: row.credibilityMetricsValid,
        credibilityDecision: row.credibilityDecision,
        historyValidity: row.historyValidity,
        historyComplete: row.historyComplete,
        throughBlock: row.throughBlock,
        calculatedAt: row.calculatedAt,
        metricVersion: row.metricVersion,
      } satisfies DurableMetricsRow,
    ])
  );
  const coverageByWallet = new Map(
    coverageRows.map((row) => [
      row.walletAddress.toLowerCase(),
      {
        walletAddress: row.walletAddress,
        lastIndexedBlock: row.lastIndexedBlock,
        eventHistoryComplete: row.eventHistoryComplete,
        historyComplete: row.historyComplete,
        historyValidity: row.historyValidity,
        updatedAt: row.updatedAt,
      } satisfies DurableCoverageRow,
    ])
  );

  const reports: EligibleWalletReport[] = [];
  for (const wallet of wallets) {
    const batchStatus = classifyMutuallyExclusiveBatchBucket(
      statusByWallet.get(wallet)
    );
    const metrics = metricsByWallet.get(wallet);
    const coverage = coverageByWallet.get(wallet);
    const structurallyValid = isDurableStructurallyValid({
      metrics,
      coverage,
      batchStatus,
    });
    const eligibleFloor10 = isDurableCalibrationEligible({
      metrics,
      coverage,
      batchStatus,
      floor: 10,
    });
    reports.push({
      wallet,
      batchStatus,
      completedPositions: metrics?.completedPositions ?? null,
      coverageState: {
        lastIndexedBlock: coverage?.lastIndexedBlock ?? null,
        eventHistoryComplete: coverage?.eventHistoryComplete ?? null,
        historyComplete: coverage?.historyComplete ?? null,
        historyValidity: coverage?.historyValidity ?? null,
      },
      metrics: {
        metricVersion: metrics?.metricVersion ?? null,
        credibilityMetricsValid: metrics?.credibilityMetricsValid ?? null,
        credibilityDecision: metrics?.credibilityDecision ?? null,
        historyValidity: metrics?.historyValidity ?? null,
        historyComplete: metrics?.historyComplete ?? null,
        throughBlock: metrics?.throughBlock ?? null,
        calculatedAt: metrics?.calculatedAt?.toISOString() ?? null,
      },
      structurallyValid,
      eligibleFloor10,
      reason: eligibilityReason({
        batchStatus,
        structurallyValid,
        completedPositions: metrics?.completedPositions ?? 0,
      }),
    });
  }

  const eligible = reports.filter((report) => report.eligibleFloor10);
  const nearMiss = reports.filter(
    (report) =>
      report.structurallyValid &&
      !report.eligibleFloor10 &&
      (report.completedPositions ?? 0) >= 8
  );

  console.log(
    JSON.stringify(
      {
        batchId: STAGE_C_BATCH_ID,
        cohortSize: wallets.length,
        eligibleFloor10Count: eligible.length,
        metricVersionExpected: WALLET_METRIC_VERSION,
        eligibleWallets: eligible.map((report) => ({
          wallet: report.wallet,
          completedPositions: report.completedPositions,
          credibilityMetricsValid: report.metrics.credibilityMetricsValid,
        })),
        nearMissStructurallyValidBelowFloor: nearMiss,
        structurallyValidNotEligible: reports
          .filter((report) => report.structurallyValid && !report.eligibleFloor10)
          .map((report) => ({
            wallet: report.wallet,
            completedPositions: report.completedPositions,
            reason: report.reason,
          })),
      },
      null,
      2
    )
  );
}

void main();
