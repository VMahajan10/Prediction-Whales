import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletShadowBatchStatus,
} from "@/lib/crossmarket/store/schema";
import { HISTORICAL_PERFORMANCE_POLICY_VERSION } from "@/lib/walletLedger/indexed/credibilityContractV2";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  loadStageCDurableEligibleWallets,
  summarizeProductionVsHistoricalPerformance,
} from "@/lib/walletLedger/indexed/shadow/stageCDurablePopulation";
import { STAGE_C_ELIGIBILITY_TARGET } from "@/lib/walletLedger/indexed/shadow/cohortStageC";
import {
  classifyMutuallyExclusiveBatchBucket,
  summarizeMutuallyExclusiveBatchBuckets,
  summarizeValidityEvidenceDimensions,
  verifyDurableEligibleWallets,
  type DurableCoverageRow,
  type DurableMetricsRow,
} from "@/lib/walletLedger/indexed/shadow/stageCReconciliation";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

export const STAGE_C_COHORT_PATH = join(
  process.cwd(),
  "tmp/wallet-history/phase2e2-stageC-cohort.json"
);

export type StageCInterimReport = {
  batchId: string;
  mode: "interim_read_only";
  cohortSize: number;
  batchStatusBuckets: ReturnType<typeof summarizeMutuallyExclusiveBatchBuckets>;
  batchStatusSum: number;
  attempted: number;
  neverAttempted: number;
  complete: number;
  unusable: number;
  deferredInfra: number;
  deferredExhausted: number;
  walletFailed: number;
  internalError: number;
  running: number;
  pending: number;
  validityEvidence: ReturnType<typeof summarizeValidityEvidenceDimensions>;
  historicalPerformanceQualification: "resolved_policy_a";
  historicalPerformancePolicyVersion: string;
  historicalPerformanceSummary: {
    eligibleFloor10Durable: number;
    passN: number;
    failN: number;
    unknownN: number;
    passRate: number | null;
    productionDisagreement: ReturnType<
      typeof summarizeProductionVsHistoricalPerformance
    >;
  };
  eligibilityTarget: number;
  gapToTargetFloor10: number;
  durableEligibleVerification: {
    floor: number;
    eligibleCount: number;
    rejectedCount: number;
    rejectedSample: Array<{ wallet: string; reason: string }>;
  };
  invocationDelta?: {
    since: string;
    newlyDurableEligibleFloor10: number;
    wallets: string[];
  };
};

export async function buildStageCInterimReport(input: {
  batchId?: string;
  cohortPath?: string;
  sinceIso?: string;
}): Promise<StageCInterimReport> {
  const batchId = input.batchId ?? STAGE_C_BATCH_ID;
  const cohortPath = input.cohortPath ?? STAGE_C_COHORT_PATH;
  const cohort: Array<{ wallet: string }> = JSON.parse(
    readFileSync(cohortPath, "utf8")
  ).wallets;
  const wallets = cohort.map((w) => w.wallet.toLowerCase());
  const db = getDb();

  const statusRows = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(sql`${walletShadowBatchStatus.batchId} = ${batchId}`);

  const statusByWallet = new Map(
    statusRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );

  const metricsRows = await db
    .select({
      walletAddress: walletHistoricalMetrics.walletAddress,
      completedPositions: walletHistoricalMetrics.completedPositions,
      realizedRoi: walletHistoricalMetrics.realizedRoi,
      profitablePositionRate: walletHistoricalMetrics.profitablePositionRate,
      credibilityMetricsValid: walletHistoricalMetrics.credibilityMetricsValid,
      credibilityDecision: walletHistoricalMetrics.credibilityDecision,
      historyValidity: walletHistoricalMetrics.historyValidity,
      historyComplete: walletHistoricalMetrics.historyComplete,
      throughBlock: walletHistoricalMetrics.throughBlock,
      calculatedAt: walletHistoricalMetrics.calculatedAt,
      metricVersion: walletHistoricalMetrics.metricVersion,
    })
    .from(walletHistoricalMetrics)
    .where(
      sql`${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION} AND ${walletHistoricalMetrics.walletAddress} IN (${sql.join(
        wallets.map((w) => sql`${w}`),
        sql`, `
      )})`
    );

  const coverageRows = await db
    .select({
      walletAddress: walletHistoryCoverage.walletAddress,
      lastIndexedBlock: walletHistoryCoverage.lastIndexedBlock,
      eventHistoryComplete: walletHistoryCoverage.eventHistoryComplete,
      historyComplete: walletHistoryCoverage.historyComplete,
      historyValidity: walletHistoryCoverage.historyValidity,
      updatedAt: walletHistoryCoverage.updatedAt,
    })
    .from(walletHistoryCoverage)
    .where(
      sql`${walletHistoryCoverage.walletAddress} IN (${sql.join(
        wallets.map((w) => sql`${w}`),
        sql`, `
      )})`
    );

  const metricsByWallet = new Map<string, DurableMetricsRow>(
    metricsRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );
  const coverageByWallet = new Map<string, DurableCoverageRow>(
    coverageRows.map((r) => [r.walletAddress.toLowerCase(), r])
  );

  const batchStatusBuckets = summarizeMutuallyExclusiveBatchBuckets(
    wallets,
    statusByWallet
  );
  const batchStatusSum = Object.values(batchStatusBuckets).reduce(
    (sum, n) => sum + n,
    0
  );

  const validityEvidence = summarizeValidityEvidenceDimensions({
    cohortWallets: wallets,
    statusByWallet,
    metricsByWallet,
    coverageByWallet,
  });

  const durableEligibleVerification = verifyDurableEligibleWallets({
    cohortWallets: wallets,
    statusByWallet,
    metricsByWallet,
    coverageByWallet,
    floor: 10,
  });

  const durableEligibleWallets = await loadStageCDurableEligibleWallets({
    batchId,
    cohortPath,
  });
  const historicalPerformanceSummary = {
    eligibleFloor10Durable: durableEligibleWallets.length,
    passN: durableEligibleWallets.filter(
      (w) => w.historicalPerformanceDecision === "PASS"
    ).length,
    failN: durableEligibleWallets.filter(
      (w) => w.historicalPerformanceDecision === "FAIL"
    ).length,
    unknownN: durableEligibleWallets.filter(
      (w) => w.historicalPerformanceDecision === "UNKNOWN"
    ).length,
    passRate:
      durableEligibleWallets.length > 0
        ? durableEligibleWallets.filter(
            (w) => w.historicalPerformanceDecision === "PASS"
          ).length / durableEligibleWallets.length
        : null,
    productionDisagreement: summarizeProductionVsHistoricalPerformance(
      durableEligibleWallets
    ),
  };

  const report: StageCInterimReport = {
    batchId,
    mode: "interim_read_only",
    cohortSize: wallets.length,
    batchStatusBuckets,
    batchStatusSum,
    attempted: wallets.length - batchStatusBuckets.never_attempted,
    neverAttempted: batchStatusBuckets.never_attempted,
    complete: batchStatusBuckets.complete,
    unusable: batchStatusBuckets.unusable,
    deferredInfra: batchStatusBuckets.deferred_infra,
    deferredExhausted: batchStatusBuckets.deferred_exhausted,
    walletFailed: batchStatusBuckets.wallet_failed,
    internalError: batchStatusBuckets.internal_error,
    running: batchStatusBuckets.running,
    pending: batchStatusBuckets.pending,
    validityEvidence,
    historicalPerformanceQualification: "resolved_policy_a",
    historicalPerformancePolicyVersion: HISTORICAL_PERFORMANCE_POLICY_VERSION,
    historicalPerformanceSummary,
    eligibilityTarget: STAGE_C_ELIGIBILITY_TARGET,
    gapToTargetFloor10: Math.max(
      0,
      STAGE_C_ELIGIBILITY_TARGET - validityEvidence.eligibleFloor10Durable
    ),
    durableEligibleVerification: {
      floor: 10,
      eligibleCount: durableEligibleVerification.eligible.length,
      rejectedCount: durableEligibleVerification.rejected.length,
      rejectedSample: durableEligibleVerification.rejected.slice(0, 10),
    },
  };

  if (input.sinceIso) {
    const sinceMs = Date.parse(input.sinceIso);
    const newlyEligible: string[] = [];
    for (const wallet of wallets) {
      const metrics = metricsByWallet.get(wallet);
      const coverage = coverageByWallet.get(wallet);
      const status = statusByWallet.get(wallet);
      const batchBucket = classifyMutuallyExclusiveBatchBucket(status);
      const becameEligible =
        metrics?.calculatedAt &&
        metrics.calculatedAt.getTime() >= sinceMs &&
        verifyDurableEligibleWallets({
          cohortWallets: [wallet],
          statusByWallet,
          metricsByWallet,
          coverageByWallet,
          floor: 10,
        }).eligible.length === 1;
      if (becameEligible) newlyEligible.push(wallet);
    }
    report.invocationDelta = {
      since: input.sinceIso,
      newlyDurableEligibleFloor10: newlyEligible.length,
      wallets: newlyEligible,
    };
  }

  return report;
}
