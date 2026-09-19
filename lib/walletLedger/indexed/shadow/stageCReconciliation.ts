import { observationalExperienceFloorDecision } from "@/lib/walletLedger/indexed/credibilityContractV2";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  isDeferRetryBudgetExhausted,
  type ResumableWalletBuckets,
  bucketResumableWallets,
} from "@/lib/walletLedger/indexed/shadow/batchScheduling";
import type { walletShadowBatchStatus } from "@/lib/crossmarket/store/schema";

type BatchStatusRow = typeof walletShadowBatchStatus.$inferSelect;

export type MutuallyExclusiveBatchBucket =
  | "never_attempted"
  | "complete"
  | "unusable"
  | "wallet_failed"
  | "internal_error"
  | "deferred_infra"
  | "deferred_exhausted"
  | "running"
  | "pending";

export type DurableMetricsRow = {
  walletAddress: string;
  completedPositions: number;
  realizedRoi?: number | null;
  profitablePositionRate?: number | null;
  credibilityMetricsValid: boolean | null;
  credibilityDecision: boolean | null;
  historyValidity: string | null;
  historyComplete: boolean | null;
  throughBlock: number | null;
  calculatedAt: Date | null;
  metricVersion: string;
};

export type DurableCoverageRow = {
  walletAddress: string;
  lastIndexedBlock: number | null;
  eventHistoryComplete: boolean | null;
  historyComplete: boolean | null;
  historyValidity: string | null;
  updatedAt: Date | null;
};

export function classifyMutuallyExclusiveBatchBucket(
  row: BatchStatusRow | undefined
): MutuallyExclusiveBatchBucket {
  if (!row) return "never_attempted";
  if (row.status === "complete") return "complete";
  if (row.status === "unusable") return "unusable";
  if (row.status === "wallet_failed") return "wallet_failed";
  if (row.status === "internal_error") return "internal_error";
  if (row.status === "running") return "running";
  if (row.status === "pending") return "pending";
  if (
    row.status === "deferred_infra" ||
    row.status === "failed"
  ) {
    return isDeferRetryBudgetExhausted(row)
      ? "deferred_exhausted"
      : "deferred_infra";
  }
  return "pending";
}

export function summarizeMutuallyExclusiveBatchBuckets(
  cohortWallets: string[],
  statusByWallet: Map<string, BatchStatusRow>
): Record<MutuallyExclusiveBatchBucket, number> {
  const counts: Record<MutuallyExclusiveBatchBucket, number> = {
    never_attempted: 0,
    complete: 0,
    unusable: 0,
    wallet_failed: 0,
    internal_error: 0,
    deferred_infra: 0,
    deferred_exhausted: 0,
    running: 0,
    pending: 0,
  };
  for (const wallet of cohortWallets) {
    const bucket = classifyMutuallyExclusiveBatchBucket(
      statusByWallet.get(wallet.toLowerCase())
    );
    counts[bucket] += 1;
  }
  return counts;
}

export function isDurableStructurallyValid(input: {
  metrics: DurableMetricsRow | undefined;
  coverage: DurableCoverageRow | undefined;
  batchStatus: MutuallyExclusiveBatchBucket;
}): boolean {
  if (input.batchStatus !== "complete") return false;
  if (!input.metrics || !input.coverage) return false;
  if (input.metrics.metricVersion !== WALLET_METRIC_VERSION) return false;
  return Boolean(
    input.metrics.credibilityMetricsValid ?? input.metrics.credibilityDecision
  );
}

export function isDurableCalibrationEligible(input: {
  metrics: DurableMetricsRow | undefined;
  coverage: DurableCoverageRow | undefined;
  batchStatus: MutuallyExclusiveBatchBucket;
  floor: number;
}): boolean {
  if (!isDurableStructurallyValid(input)) return false;
  const completedPositionCount = input.metrics?.completedPositions ?? 0;
  return observationalExperienceFloorDecision({
    indexedDataValidity: true,
    completedPositionCount,
    floor: input.floor,
  });
}

export type ValidityEvidenceDimensions = {
  structurallyValidDurable: number;
  eligibleFloor10Durable: number;
  eligibleFloor20Durable: number;
  eligibleFloor50Durable: number;
  validBelowEvidenceFloor: number;
  metricsUnsafeValidity: number;
  missingOrIncompleteDurable: number;
};

export function summarizeValidityEvidenceDimensions(input: {
  cohortWallets: string[];
  statusByWallet: Map<string, BatchStatusRow>;
  metricsByWallet: Map<string, DurableMetricsRow>;
  coverageByWallet: Map<string, DurableCoverageRow>;
}): ValidityEvidenceDimensions {
  let structurallyValidDurable = 0;
  let eligibleFloor10Durable = 0;
  let eligibleFloor20Durable = 0;
  let eligibleFloor50Durable = 0;
  let validBelowEvidenceFloor = 0;
  let metricsUnsafeValidity = 0;
  let missingOrIncompleteDurable = 0;

  for (const wallet of input.cohortWallets) {
    const key = wallet.toLowerCase();
    const batchStatus = classifyMutuallyExclusiveBatchBucket(
      input.statusByWallet.get(key)
    );
    const metrics = input.metricsByWallet.get(key);
    const coverage = input.coverageByWallet.get(key);
    const historyValidity =
      metrics?.historyValidity ?? coverage?.historyValidity ?? null;

    if (historyValidity === "partial-and-metrics-unsafe") {
      metricsUnsafeValidity += 1;
    }

    if (isDurableCalibrationEligible({
      metrics,
      coverage,
      batchStatus,
      floor: 10,
    })) {
      eligibleFloor10Durable += 1;
    }
    if (isDurableCalibrationEligible({
      metrics,
      coverage,
      batchStatus,
      floor: 20,
    })) {
      eligibleFloor20Durable += 1;
    }
    if (isDurableCalibrationEligible({
      metrics,
      coverage,
      batchStatus,
      floor: 50,
    })) {
      eligibleFloor50Durable += 1;
    }

    if (isDurableStructurallyValid({ metrics, coverage, batchStatus })) {
      structurallyValidDurable += 1;
      const completed = metrics?.completedPositions ?? 0;
      if (completed < 10) validBelowEvidenceFloor += 1;
      continue;
    }

    missingOrIncompleteDurable += 1;
  }

  return {
    structurallyValidDurable,
    eligibleFloor10Durable,
    eligibleFloor20Durable,
    eligibleFloor50Durable,
    validBelowEvidenceFloor,
    metricsUnsafeValidity,
    missingOrIncompleteDurable,
  };
}

export function scheduleWalletsForPass(
  pass: "full" | "passA" | "passB",
  cohort: Array<{ wallet: string }>,
  statusByWallet: Map<string, BatchStatusRow>
): Array<{ wallet: string }> {
  const buckets: ResumableWalletBuckets = bucketResumableWallets(
    cohort as Parameters<typeof bucketResumableWallets>[0],
    statusByWallet
  );
  if (pass === "passA") return buckets.neverAttempted;
  if (pass === "passB") return buckets.deferredRetryable;
  return [...buckets.neverAttempted, ...buckets.deferredRetryable];
}

export function verifyDurableEligibleWallets(input: {
  cohortWallets: string[];
  statusByWallet: Map<string, BatchStatusRow>;
  metricsByWallet: Map<string, DurableMetricsRow>;
  coverageByWallet: Map<string, DurableCoverageRow>;
  floor: number;
}): {
  eligible: string[];
  rejected: Array<{ wallet: string; reason: string }>;
} {
  const eligible: string[] = [];
  const rejected: Array<{ wallet: string; reason: string }> = [];

  for (const wallet of input.cohortWallets) {
    const key = wallet.toLowerCase();
    const batchStatus = classifyMutuallyExclusiveBatchBucket(
      input.statusByWallet.get(key)
    );
    const metrics = input.metricsByWallet.get(key);
    const coverage = input.coverageByWallet.get(key);

    if (batchStatus !== "complete") {
      rejected.push({ wallet: key, reason: `batch_status=${batchStatus}` });
      continue;
    }
    if (!metrics) {
      rejected.push({ wallet: key, reason: "missing_durable_metrics" });
      continue;
    }
    if (metrics.metricVersion !== WALLET_METRIC_VERSION) {
      rejected.push({
        wallet: key,
        reason: `metric_version=${metrics.metricVersion}`,
      });
      continue;
    }
    if (!coverage) {
      rejected.push({ wallet: key, reason: "missing_durable_coverage" });
      continue;
    }
    if (!(metrics.credibilityMetricsValid ?? metrics.credibilityDecision)) {
      rejected.push({ wallet: key, reason: "not_structurally_valid" });
      continue;
    }
    if ((metrics.completedPositions ?? 0) < input.floor) {
      rejected.push({
        wallet: key,
        reason: `completed_positions=${metrics.completedPositions ?? 0}`,
      });
      continue;
    }
    eligible.push(key);
  }

  return { eligible, rejected };
}
