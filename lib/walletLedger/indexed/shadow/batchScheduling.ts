import type { ShadowCohortWallet } from "@/lib/walletLedger/indexed/shadow/cohort";
import type { walletShadowBatchStatus } from "@/lib/crossmarket/store/schema";

type BatchStatusRow = typeof walletShadowBatchStatus.$inferSelect;

export const TERMINAL_WALLET_STATUSES = new Set([
  "complete",
  "unusable",
  "wallet_failed",
  "internal_error",
]);

export const DEFER_RETRY_BUDGET_EXHAUSTED = "retry_budget_exhausted" as const;

export function resolveStageCDeferMaxAttempts(): number {
  const raw = process.env.STAGE_C_DEFER_MAX_ATTEMPTS?.trim();
  const parsed = raw ? Number(raw) : 3;
  if (!Number.isFinite(parsed) || parsed <= 0) return 3;
  return Math.floor(parsed);
}

export function readDeferAttempts(
  performance: Record<string, unknown> | null | undefined
): number {
  const value = performance?.deferAttempts;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isDeferRetryBudgetExhausted(row: BatchStatusRow | undefined): boolean {
  if (!row) return false;
  if (row.status !== "deferred_infra" && row.status !== "failed") return false;
  if (row.errorMessage?.includes(DEFER_RETRY_BUDGET_EXHAUSTED)) return true;
  return readDeferAttempts(row.performance) >= resolveStageCDeferMaxAttempts();
}

export function isWalletSchedulingTerminal(
  row: BatchStatusRow | undefined
): boolean {
  if (!row) return false;
  if (TERMINAL_WALLET_STATUSES.has(row.status)) return true;
  return isDeferRetryBudgetExhausted(row);
}

export function nextDeferPerformance(
  prior: BatchStatusRow | null | undefined,
  performance?: Record<string, unknown>,
  incrementDefer = false
): Record<string, unknown> {
  const priorPerf =
    prior?.performance && typeof prior.performance === "object"
      ? (prior.performance as Record<string, unknown>)
      : {};
  const merged = { ...priorPerf, ...(performance ?? {}) };
  if (incrementDefer) {
    merged.deferAttempts = readDeferAttempts(priorPerf) + 1;
    merged.lastDeferAt = new Date().toISOString();
  } else if (merged.deferAttempts == null) {
    merged.deferAttempts = readDeferAttempts(priorPerf);
  }
  return merged;
}

export type ResumableWalletBuckets = {
  neverAttempted: ShadowCohortWallet[];
  deferredRetryable: ShadowCohortWallet[];
  deferredExhausted: string[];
  terminal: string[];
  staleRunning: string[];
};

export function bucketResumableWallets(
  cohort: ShadowCohortWallet[],
  statusByWallet: Map<string, BatchStatusRow>
): ResumableWalletBuckets {
  const buckets: ResumableWalletBuckets = {
    neverAttempted: [],
    deferredRetryable: [],
    deferredExhausted: [],
    terminal: [],
    staleRunning: [],
  };

  for (const spec of cohort) {
    const key = spec.wallet.toLowerCase();
    const row = statusByWallet.get(key);
    if (!row) {
      buckets.neverAttempted.push(spec);
      continue;
    }
    if (isWalletSchedulingTerminal(row)) {
      if (isDeferRetryBudgetExhausted(row)) {
        buckets.deferredExhausted.push(key);
      } else {
        buckets.terminal.push(key);
      }
      continue;
    }
    if (row.status === "running") {
      buckets.staleRunning.push(key);
    }
    if (
      row.status === "deferred_infra" ||
      row.status === "failed" ||
      row.status === "pending" ||
      row.status === "running"
    ) {
      buckets.deferredRetryable.push(spec);
    }
  }

  return buckets;
}

export type SchedulingPass = "full" | "passA" | "passB";

/**
 * Pass A: never-attempted wallets in cohort order.
 * Pass B: retryable deferred/pending/stale-running wallets in cohort order.
 * Full: Pass A then Pass B.
 */
export function scheduleResumableWallets(
  cohort: ShadowCohortWallet[],
  statusByWallet: Map<string, BatchStatusRow>,
  pass: SchedulingPass = "full"
): ShadowCohortWallet[] {
  const buckets = bucketResumableWallets(cohort, statusByWallet);
  if (pass === "passA") return buckets.neverAttempted;
  if (pass === "passB") return buckets.deferredRetryable;
  return [...buckets.neverAttempted, ...buckets.deferredRetryable];
}

export function summarizeCohortScheduling(
  cohort: ShadowCohortWallet[],
  statusByWallet: Map<string, BatchStatusRow>
): {
  cohortSize: number;
  neverAttempted: number;
  deferredRetryable: number;
  deferredExhausted: number;
  terminal: number;
  staleRunning: number;
  batchConclusionReady: boolean;
} {
  const buckets = bucketResumableWallets(cohort, statusByWallet);
  const accounted =
    buckets.terminal.length +
    buckets.deferredExhausted.length +
    buckets.neverAttempted.length +
    buckets.deferredRetryable.length;
  const batchConclusionReady =
    buckets.neverAttempted.length === 0 &&
    buckets.deferredRetryable.length === 0 &&
    buckets.staleRunning.length === 0 &&
    accounted === cohort.length;

  return {
    cohortSize: cohort.length,
    neverAttempted: buckets.neverAttempted.length,
    deferredRetryable: buckets.deferredRetryable.length,
    deferredExhausted: buckets.deferredExhausted.length,
    terminal: buckets.terminal.length,
    staleRunning: buckets.staleRunning.length,
    batchConclusionReady,
  };
}

export function markDeferRetryBudgetExhaustedMessage(
  errorMessage: string | null | undefined
): string {
  const base = errorMessage?.trim() || "deferred_infra";
  if (base.includes(DEFER_RETRY_BUDGET_EXHAUSTED)) return base;
  return `${base}; ${DEFER_RETRY_BUDGET_EXHAUSTED}`;
}
