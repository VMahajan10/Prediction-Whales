#!/usr/bin/env tsx
import "./preload-env";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletShadowBatchStatus,
} from "@/lib/crossmarket/store/schema";
import {
  classifyMutuallyExclusiveBatchBucket,
  isDurableCalibrationEligible,
  isDurableStructurallyValid,
} from "@/lib/walletLedger/indexed/shadow/stageCReconciliation";
import { STAGE_C_COHORT_PATH } from "@/lib/walletLedger/indexed/shadow/stageCInterimAnalysis";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

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
    metricsRows.map((row) => [row.walletAddress.toLowerCase(), row])
  );
  const coverageByWallet = new Map(
    coverageRows.map((row) => [row.walletAddress.toLowerCase(), row])
  );

  const eligibleNow: string[] = [];
  const completeGte10NotEligible: Array<Record<string, unknown>> = [];

  for (const wallet of wallets) {
    const statusRow = statusByWallet.get(wallet);
    const metrics = metricsByWallet.get(wallet);
    const coverage = coverageByWallet.get(wallet);
    const batchStatus = classifyMutuallyExclusiveBatchBucket(statusRow);
    const eligible = isDurableCalibrationEligible({
      metrics: metrics
        ? {
            walletAddress: metrics.walletAddress,
            completedPositions: metrics.completedPositions,
            credibilityMetricsValid: metrics.credibilityMetricsValid,
            credibilityDecision: metrics.credibilityDecision,
            historyValidity: metrics.historyValidity,
            historyComplete: metrics.historyComplete,
            throughBlock: metrics.throughBlock,
            calculatedAt: metrics.calculatedAt,
            metricVersion: metrics.metricVersion,
          }
        : undefined,
      coverage: coverage
        ? {
            walletAddress: coverage.walletAddress,
            lastIndexedBlock: coverage.lastIndexedBlock,
            eventHistoryComplete: coverage.eventHistoryComplete,
            historyComplete: coverage.historyComplete,
            historyValidity: coverage.historyValidity,
            updatedAt: coverage.updatedAt,
          }
        : undefined,
      batchStatus,
      floor: 10,
    });
    if (eligible) eligibleNow.push(wallet);
    if (
      (metrics?.completedPositions ?? 0) >= 10 &&
      !eligible
    ) {
      completeGte10NotEligible.push({
        wallet,
        batchStatus,
        status: statusRow?.status,
        updatedAt: statusRow?.updatedAt?.toISOString(),
        completedPositions: metrics?.completedPositions,
        credibilityMetricsValid: metrics?.credibilityMetricsValid,
        metricVersion: metrics?.metricVersion,
        structurallyValid: isDurableStructurallyValid({
          metrics: metrics
            ? {
                walletAddress: metrics.walletAddress,
                completedPositions: metrics.completedPositions,
                credibilityMetricsValid: metrics.credibilityMetricsValid,
                credibilityDecision: metrics.credibilityDecision,
                historyValidity: metrics.historyValidity,
                historyComplete: metrics.historyComplete,
                throughBlock: metrics.throughBlock,
                calculatedAt: metrics.calculatedAt,
                metricVersion: metrics.metricVersion,
              }
            : undefined,
          coverage: coverage
            ? {
                walletAddress: coverage.walletAddress,
                lastIndexedBlock: coverage.lastIndexedBlock,
                eventHistoryComplete: coverage.eventHistoryComplete,
                historyComplete: coverage.historyComplete,
                historyValidity: coverage.historyValidity,
                updatedAt: coverage.updatedAt,
              }
            : undefined,
          batchStatus,
        }),
      });
    }
  }

  const recentlyUpdated = statusRows
    .filter((row) => row.status === "complete" || row.status === "unusable")
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, 15)
    .map((row) => ({
      wallet: row.walletAddress,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
      completedPositions:
        metricsByWallet.get(row.walletAddress.toLowerCase())?.completedPositions ??
        null,
      eligible: eligibleNow.includes(row.walletAddress.toLowerCase()),
    }));

  console.log(
    JSON.stringify(
      {
        eligibleFloor10Count: eligibleNow.length,
        completeGte10NotEligible,
        recentlyUpdatedCompleteOrUnusable: recentlyUpdated,
      },
      null,
      2
    )
  );
}

void main();
