/**
 * Bounded indexed-history hydration for production-relevant wallets.
 * Reuses the existing indexed audit + persistence pipeline.
 */

import { sql, eq } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  policyAProductionWalletHydration,
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import {
  persistAuthoritativePhase,
  persistDerivedPhase,
  walletHistoryDbEnabled,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import {
  evaluateHistoricalPerformanceVerdict,
  hasDefinitivePolicyAVerdict,
  type PolicyAMetricsSnapshot,
} from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  buildProductionWalletCohort,
  type ProductionWalletCohortMember,
} from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";

export const HYDRATION_ELIGIBLE_UNKNOWN_REASONS = [
  "incomplete_indexed_history",
  "hydration_pending",
  "hydration_failed",
  "no_indexed_history",
  "invalid_indexed_history",
  "missing_metrics",
] as const;

export type HydrationGate = "PASS" | "FAIL" | "UNKNOWN";

export function computeHydrationGate(input: {
  coverage: {
    identityComplete: boolean;
    eventHistoryComplete: boolean;
  } | null;
  hasValidationSnapshot?: boolean;
}): HydrationGate {
  if (
    input.coverage?.identityComplete === true &&
    input.coverage?.eventHistoryComplete === true
  ) {
    return "PASS";
  }
  if (input.hasValidationSnapshot) return "PASS";
  if (input.coverage) return "FAIL";
  return "UNKNOWN";
}

function isIdentityRepairPath(reasons: string[]): boolean {
  return reasons.some(
    (reason) =>
      reason.startsWith("identity_") ||
      reason === "positions_without_history_events"
  );
}

function needsRepairableHydrationWork(
  reasons: string[],
  historyValidity: string | null | undefined
): boolean {
  return (
    reasons.includes("activity_truncated") ||
    reasons.includes("trades_truncated") ||
    reasons.includes("historical_backfill_required") ||
    historyValidity === "partial-and-metrics-unsafe"
  );
}

export function assessBatchHydrationEligibility(input: {
  member: ProductionWalletCohortMember;
  metricReasons: string[];
  hydrationStatus: string | null;
  coverage: {
    identityComplete: boolean;
    eventHistoryComplete: boolean;
  } | null;
}): {
  eligible: boolean;
  hydrationEligibilityReason: string;
} {
  const { member, metricReasons, hydrationStatus, coverage } = input;

  if (metricReasons.includes("unresolved_chain_order")) {
    return {
      eligible: false,
      hydrationEligibilityReason: "excluded_class_d_recovery_pending",
    };
  }

  if (member.policyADecision !== "UNKNOWN") {
    return {
      eligible: false,
      hydrationEligibilityReason: "excluded_definitive_policy_a",
    };
  }

  if (isIdentityRepairPath(metricReasons)) {
    return {
      eligible: false,
      hydrationEligibilityReason: "excluded_identity_repair_path",
    };
  }

  const hydrationGate = computeHydrationGate({ coverage });
  const hydrationComplete =
    hydrationStatus === "complete" ||
    member.productionHydrationState === "complete";
  const trustworthy = member.hasValidDurableCoverage;
  const unknownReason = member.policyAUnknownReason ?? "no_indexed_history";

  if (hydrationComplete && hydrationGate === "PASS" && trustworthy) {
    if (unknownReason === "insufficient_completed_positions") {
      return {
        eligible: false,
        hydrationEligibilityReason:
          "excluded_final_unknown_insufficient_completed_positions",
      };
    }
    if (
      (member.completedPositions ?? 0) < 10 &&
      member.historyValidity === "partial-but-metrics-safe" &&
      !needsRepairableHydrationWork(metricReasons, member.historyValidity)
    ) {
      return {
        eligible: false,
        hydrationEligibilityReason:
          "excluded_already_hydrated_trustworthy_low_sample_unknown",
      };
    }
    if (!needsRepairableHydrationWork(metricReasons, member.historyValidity)) {
      return {
        eligible: false,
        hydrationEligibilityReason: "excluded_already_hydrated",
      };
    }
  }

  if (
    !HYDRATION_ELIGIBLE_UNKNOWN_REASONS.includes(
      unknownReason as (typeof HYDRATION_ELIGIBLE_UNKNOWN_REASONS)[number]
    )
  ) {
    return {
      eligible: false,
      hydrationEligibilityReason: `excluded_unknown_reason_${unknownReason}`,
    };
  }

  return {
    eligible: true,
    hydrationEligibilityReason: `eligible_${unknownReason}`,
  };
}

export async function loadBatchHydrationEligibilityContext(wallet: string): Promise<{
  hydrationStatus: string | null;
  hydrationUpdatedAt: Date | null;
  coverage: {
    identityComplete: boolean;
    eventHistoryComplete: boolean;
  } | null;
  metricReasons: string[];
}> {
  const normalized = wallet.toLowerCase();
  const db = getDb();
  const [hydration] = await db
    .select()
    .from(policyAProductionWalletHydration)
    .where(eq(policyAProductionWalletHydration.walletAddress, normalized))
    .limit(1);
  const [coverage] = await db
    .select({
      identityComplete: walletHistoryCoverage.identityComplete,
      eventHistoryComplete: walletHistoryCoverage.eventHistoryComplete,
    })
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, normalized))
    .limit(1);
  const [metrics] = await db
    .select({
      reasons: walletHistoricalMetrics.historyIncompleteReasons,
    })
    .from(walletHistoricalMetrics)
    .where(
      sql`${walletHistoricalMetrics.walletAddress} = ${normalized} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
    )
    .limit(1);

  return {
    hydrationStatus: hydration?.status ?? null,
    hydrationUpdatedAt: hydration?.updatedAt ?? null,
    coverage: coverage ?? null,
    metricReasons: metrics?.reasons ?? [],
  };
}

export function shouldSkipPolicyAHydration(input: {
  metrics: PolicyAMetricsSnapshot | null;
}): boolean {
  return hasDefinitivePolicyAVerdict(
    input.metrics,
    input.metrics?.historyIncompleteReasons
  );
}

export interface ProductionWalletHydrationResult {
  wallet: string;
  status: "complete" | "failed" | "skipped";
  reason?: string;
  completedPositions?: number | null;
  historyValidity?: string | null;
  policyADecision?: string;
  elapsedMs?: number;
}

export async function upsertHydrationQueueFromCohort(): Promise<number> {
  if (!isDatabaseEnabled()) return 0;
  const cohort = await buildProductionWalletCohort();
  const db = getDb();
  let upserted = 0;
  for (const member of cohort.wallets) {
    const skipHydration = shouldSkipPolicyAHydration({
      metrics: member.hasIndexedMetrics
        ? {
            credibilityMetricsValid: member.indexedDataValidity,
            historyValidity: member.historyValidity,
            historyComplete: member.historyComplete,
            completedPositions: member.completedPositions,
            realizedRoi: member.realizedRoi,
            profitablePositionRate: member.profitablePositionRate,
            metricVersion: WALLET_METRIC_VERSION,
          }
        : null,
    });
    if (skipHydration) {
      await db
        .insert(policyAProductionWalletHydration)
        .values({
          walletAddress: member.wallet,
          priorityTier: member.priorityTier,
          status: "skipped",
          completedPositions: member.completedPositions,
          historyValidity: member.historyValidity,
          policyADecision: member.policyADecision,
        })
        .onConflictDoUpdate({
          target: policyAProductionWalletHydration.walletAddress,
          set: {
            priorityTier: sql`excluded.priority_tier`,
            status: sql`'skipped'`,
            completedPositions: sql`excluded.completed_positions`,
            historyValidity: sql`excluded.history_validity`,
            policyADecision: sql`excluded.policy_a_decision`,
            updatedAt: sql`now()`,
          },
        });
      continue;
    }
    await db
      .insert(policyAProductionWalletHydration)
      .values({
        walletAddress: member.wallet,
        priorityTier: member.priorityTier,
        status: "pending",
        completedPositions: member.completedPositions,
        historyValidity: member.historyValidity,
        policyADecision: member.policyADecision,
      })
      .onConflictDoUpdate({
        target: policyAProductionWalletHydration.walletAddress,
        set: {
          priorityTier: sql`excluded.priority_tier`,
          updatedAt: sql`now()`,
        },
      });
    upserted += 1;
  }
  return upserted;
}

export async function hydrateProductionWallet(
  wallet: string
): Promise<ProductionWalletHydrationResult> {
  const normalized = wallet.toLowerCase();
  const db = getDb();
  const started = Date.now();

  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      sql`${walletHistoricalMetrics.walletAddress} = ${normalized} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
    )
    .limit(1);
  const [coverage] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, normalized))
    .limit(1);

  if (
    shouldSkipPolicyAHydration({
      metrics: metrics
        ? {
            credibilityMetricsValid: metrics.credibilityMetricsValid,
            historyValidity: metrics.historyValidity,
            historyComplete: metrics.historyComplete,
            completedPositions: metrics.completedPositions,
            realizedRoi: metrics.realizedRoi,
            profitablePositionRate: metrics.profitablePositionRate,
            metricVersion: metrics.metricVersion,
            historyIncompleteReasons: metrics.historyIncompleteReasons,
          }
        : null,
    })
  ) {
    const verdict = evaluateHistoricalPerformanceVerdict({
      indexedDataValidity: Boolean(metrics?.credibilityMetricsValid),
      historyValidity: metrics?.historyValidity,
      historyComplete: metrics?.historyComplete ?? undefined,
      completedPositionCount: metrics?.completedPositions ?? null,
      realizedRoi: metrics?.realizedRoi ?? null,
      profitablePositionRate: metrics?.profitablePositionRate ?? null,
      metricVersion: metrics?.metricVersion ?? null,
    });
    return {
      wallet: normalized,
      status: "skipped",
      reason: "policy_a_already_definitive",
      completedPositions: metrics?.completedPositions ?? null,
      historyValidity: metrics?.historyValidity ?? null,
      policyADecision: verdict.historicalPerformanceDecision,
    };
  }

  await db
    .update(policyAProductionWalletHydration)
    .set({ status: "running", lastAttemptAt: new Date(), updatedAt: new Date() })
    .where(eq(policyAProductionWalletHydration.walletAddress, normalized));

  try {
    if (!walletHistoryDbEnabled()) {
      throw new Error("wallet history DB not enabled");
    }
    const audit = await runIndexedWalletAudit({
      label: "policy-a-coverage",
      wallet: normalized,
      providerId: "etherscan_v2",
      fullHistory: true,
      resumeCheckpoint: true,
    });
    const phase1 = await persistAuthoritativePhase(audit);
    if (!phase1.authoritativePersistDiagnostics.baselineComplete) {
      throw new Error(
        `baseline_incomplete persistableMissingAfter=${phase1.authoritativePersistDiagnostics.persistableMissingAfter}`
      );
    }
    await persistDerivedPhase(audit);

    const [afterMetrics] = await db
      .select()
      .from(walletHistoricalMetrics)
      .where(
        sql`${walletHistoricalMetrics.walletAddress} = ${normalized} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
      )
      .limit(1);
    const verdict = evaluateHistoricalPerformanceVerdict({
      indexedDataValidity: Boolean(afterMetrics?.credibilityMetricsValid),
      historyValidity: afterMetrics?.historyValidity,
      historyComplete: afterMetrics?.historyComplete ?? undefined,
      completedPositionCount: afterMetrics?.completedPositions ?? null,
      realizedRoi: afterMetrics?.realizedRoi ?? null,
      profitablePositionRate: afterMetrics?.profitablePositionRate ?? null,
      metricVersion: afterMetrics?.metricVersion ?? null,
    });

    await db
      .update(policyAProductionWalletHydration)
      .set({
        status: "complete",
        completedPositions: afterMetrics?.completedPositions ?? null,
        historyValidity: afterMetrics?.historyValidity ?? null,
        policyADecision: verdict.historicalPerformanceDecision,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(policyAProductionWalletHydration.walletAddress, normalized));

    return {
      wallet: normalized,
      status: "complete",
      completedPositions: afterMetrics?.completedPositions ?? null,
      historyValidity: afterMetrics?.historyValidity ?? null,
      policyADecision: verdict.historicalPerformanceDecision,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(policyAProductionWalletHydration)
      .set({
        status: "failed",
        lastError: message,
        updatedAt: new Date(),
      })
      .where(eq(policyAProductionWalletHydration.walletAddress, normalized));
    return {
      wallet: normalized,
      status: "failed",
      reason: message,
      elapsedMs: Date.now() - started,
    };
  }
}

export async function runBoundedProductionWalletHydration(input?: {
  maxWallets?: number;
  wallets?: string[];
}): Promise<{
  queued: number;
  processed: ProductionWalletHydrationResult[];
}> {
  if (!isDatabaseEnabled()) {
    return { queued: 0, processed: [] };
  }
  const maxWallets = input?.maxWallets ?? 2;
  const db = getDb();

  if (input?.wallets?.length) {
    for (const wallet of input.wallets) {
      const normalized = wallet.toLowerCase();
      const [metrics] = await db
        .select()
        .from(walletHistoricalMetrics)
        .where(
          sql`${walletHistoricalMetrics.walletAddress} = ${normalized} AND ${walletHistoricalMetrics.metricVersion} = ${WALLET_METRIC_VERSION}`
        )
        .limit(1);
      const status = shouldSkipPolicyAHydration({
        metrics: metrics
          ? {
              credibilityMetricsValid: metrics.credibilityMetricsValid,
              historyValidity: metrics.historyValidity,
              historyComplete: metrics.historyComplete,
              completedPositions: metrics.completedPositions,
              realizedRoi: metrics.realizedRoi,
              profitablePositionRate: metrics.profitablePositionRate,
              metricVersion: metrics.metricVersion,
            }
          : null,
      })
        ? "skipped"
        : "pending";
      await db
        .insert(policyAProductionWalletHydration)
        .values({
          walletAddress: normalized,
          priorityTier: 1,
          status,
        })
        .onConflictDoUpdate({
          target: policyAProductionWalletHydration.walletAddress,
          set: {
            priorityTier: 1,
            status,
            updatedAt: sql`now()`,
          },
        });
    }
  } else {
    await upsertHydrationQueueFromCohort();
  }

  const pending = await db
    .select()
    .from(policyAProductionWalletHydration)
    .where(eq(policyAProductionWalletHydration.status, "pending"))
    .orderBy(policyAProductionWalletHydration.priorityTier)
    .limit(maxWallets);

  const processed: ProductionWalletHydrationResult[] = [];
  for (const row of pending) {
    processed.push(await hydrateProductionWallet(row.walletAddress));
  }

  return { queued: pending.length, processed };
}

export function summarizeCohortCoverage(members: ProductionWalletCohortMember[]) {
  const total = members.length;
  const evaluable = members.filter(
    (m) => m.policyADecision === "PASS" || m.policyADecision === "FAIL"
  ).length;
  return {
    totalWallets: total,
    indexedCoveragePct: total > 0 ? (evaluable / total) * 100 : 0,
    withIndexedMetrics: members.filter((m) => m.hasIndexedMetrics).length,
    withValidDurableCoverage: members.filter((m) => m.hasValidDurableCoverage)
      .length,
    policyAPass: members.filter((m) => m.policyADecision === "PASS").length,
    policyAFail: members.filter((m) => m.policyADecision === "FAIL").length,
    policyAUnknown: members.filter((m) => m.policyADecision === "UNKNOWN").length,
  };
}
