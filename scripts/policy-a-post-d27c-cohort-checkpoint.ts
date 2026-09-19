#!/usr/bin/env tsx
/**
 * Policy A post-d27c scale checkpoint — read-only cohort + truncation analysis.
 */
import "../tests/preload-env";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
} from "@/lib/crossmarket/store/schema";
import {
  computeSourceBoundaryStats,
  resolveSourceSpecificTruncationFlags,
} from "@/lib/walletLedger/indexed/indexedCredibility";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  buildProductionWalletCohort,
  type ProductionWalletCohortMember,
} from "@/lib/walletLedger/indexed/shadow/productionWalletCohort";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { fetchActivityHistory, fetchTradeHistory } from "@/lib/walletLedger/fetchers";
import { extractApiSourceTimestamps } from "@/lib/walletLedger/onchain/startBlock";

const EXCLUDE_WALLETS = new Set([
  "0xd27cc742d023d06ef633a4c880cf1ff1836ec081",
  "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
]);

type UnknownBucket = "A" | "B" | "C" | "D" | "E";

function classifyUnknownBucket(
  member: ProductionWalletCohortMember,
  reasons: string[]
): UnknownBucket {
  if (!member.hasIndexedMetrics && !member.hasIndexedCoverage) return "D";
  if (
    member.productionHydrationState === "pending" ||
    member.productionHydrationState === "failed" ||
    member.policyAUnknownReason === "hydration_pending" ||
    member.policyAUnknownReason === "hydration_failed" ||
    member.policyAUnknownReason === "no_indexed_history" ||
    member.policyAUnknownReason === "missing_metrics"
  ) {
    return member.policyAUnknownReason === "no_indexed_history" ||
      (!member.hasIndexedMetrics && !member.hasIndexedCoverage)
      ? "D"
      : "E";
  }

  if (
    reasons.some(
      (reason) =>
        reason.startsWith("identity_") || reason === "positions_without_history_events"
    )
  ) {
    return "C";
  }

  if (
    member.historyValidity === "partial-and-metrics-unsafe" &&
    (reasons.includes("activity_truncated") || reasons.includes("trades_truncated"))
  ) {
    return "B";
  }

  if (
    member.hasValidDurableCoverage &&
    (member.completedPositions ?? 0) < 10
  ) {
    return "A";
  }
  if (member.policyAUnknownReason === "insufficient_completed_positions") {
    return "A";
  }

  return "E";
}

async function loadMetricsReasons(wallet: string): Promise<string[]> {
  const db = getDb();
  const [row] = await db
    .select({ reasons: walletHistoricalMetrics.historyIncompleteReasons })
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, wallet.toLowerCase()),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  return row?.reasons ?? [];
}

async function analyzeTruncationWallet(wallet: string) {
  const normalized = wallet.toLowerCase();
  const db = getDb();
  const [metrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, normalized),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);
  const [coverage] = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, normalized))
    .limit(1);

  const reasons = metrics?.historyIncompleteReasons ?? [];
  const activityTruncated = reasons.includes("activity_truncated");
  const tradesTruncated = reasons.includes("trades_truncated");

  const [activity, trades] = await Promise.all([
    fetchActivityHistory(normalized, { interPageDelayMs: 25 }),
    fetchTradeHistory(normalized, { interPageDelayMs: 25 }),
  ]);
  const sourceTs = extractApiSourceTimestamps(activity.rows, trades.rows);
  const events = await loadPersistedWalletEvents(normalized);
  const boundaries = computeSourceBoundaryStats(
    events,
    sourceTs.oldestActivityTimestamp,
    sourceTs.oldestTradesTimestamp
  );
  const flags = resolveSourceSpecificTruncationFlags({
    apiActivityTruncated: activity.truncated,
    apiTradesTruncated: trades.truncated,
    oldestActivityTimestamp: sourceTs.oldestActivityTimestamp,
    oldestTradesTimestamp: sourceTs.oldestTradesTimestamp,
    runSourceBoundaries: boundaries,
  });

  const truncationCleared =
    (!activityTruncated || flags.activityTruncationImmune) &&
    (!tradesTruncated || flags.tradesTruncationImmune);

  const needsEarlierIndexing =
    (activityTruncated && !flags.activityTruncationImmune) ||
    (tradesTruncated && !flags.tradesTruncationImmune);

  return {
    wallet: normalized,
    activityTruncated,
    tradesTruncated,
    apiActivityTruncated: activity.truncated,
    apiTradesTruncated: trades.truncated,
    oldestActivityTimestamp: sourceTs.oldestActivityTimestamp,
    oldestTradesTimestamp: sourceTs.oldestTradesTimestamp,
    indexedOldestTimestamp: boundaries.indexedOldestTimestamp,
    persistedIndexedOldest: coverage?.indexedOldestTimestamp ?? null,
    eventsBeforeActivityBoundary: boundaries.eventsBeforeActivityBoundary,
    eventsBeforeTradesBoundary: boundaries.eventsBeforeTradesBoundary,
    activityTruncationImmune: flags.activityTruncationImmune,
    tradesTruncationImmune: flags.tradesTruncationImmune,
    sourceSpecificWouldClearTruncation: truncationCleared,
    semanticsAloneWouldBeMetricsSafe:
      truncationCleared && !needsEarlierIndexing,
    needsEarlierVerifiedChainIndexing: needsEarlierIndexing,
    historyValidity: metrics?.historyValidity ?? null,
    completedPositions: metrics?.completedPositions ?? null,
  };
}

function pickPilotCohort(input: {
  semanticsAlone: Array<Awaited<ReturnType<typeof analyzeTruncationWallet>>>;
  needsEarlier: Array<Awaited<ReturnType<typeof analyzeTruncationWallet>>>;
  passControl: ProductionWalletCohortMember[];
  truncationBlocked: ProductionWalletCohortMember[];
}) {
  const picks: Array<Record<string, unknown>> = [];

  const semantics = input.semanticsAlone.find(
    (row) =>
      row.sourceSpecificWouldClearTruncation &&
      !row.needsEarlierVerifiedChainIndexing &&
      !EXCLUDE_WALLETS.has(row.wallet)
  );
  if (semantics) {
    picks.push({
      role: "source_specific_semantics_alone",
      wallet: semantics.wallet,
      rationale:
        "Truncation flags clear under source-specific boundaries without earlier chain scan",
      ...semantics,
    });
  }

  const earlier = input.needsEarlier.find(
    (row) =>
      row.needsEarlierVerifiedChainIndexing &&
      !EXCLUDE_WALLETS.has(row.wallet)
  );
  if (earlier) {
    picks.push({
      role: "adaptive_earlier_chain_indexing",
      wallet: earlier.wallet,
      rationale:
        "Still truncation-blocked after source-specific semantics; indexed history does not reach activity/trades boundary",
      ...earlier,
    });
  }

  const control = input.passControl.find(
    (member) =>
      member.policyADecision === "PASS" &&
      member.hasValidDurableCoverage &&
      !EXCLUDE_WALLETS.has(member.wallet)
  );
  if (control) {
    picks.push({
      role: "metrics_safe_regression_control",
      wallet: control.wallet,
      rationale: "Existing PASS wallet with valid durable coverage",
      completedPositions: control.completedPositions,
      historyValidity: control.historyValidity,
      policyADecision: control.policyADecision,
    });
  }

  const extra = input.truncationBlocked.find(
    (member) =>
      !EXCLUDE_WALLETS.has(member.wallet) &&
      !picks.some((pick) => pick.wallet === member.wallet)
  );
  if (extra) {
    picks.push({
      role: "additional_truncation_blocked",
      wallet: extra.wallet,
      rationale: "Additional truncation-blocked wallet for pilot coverage",
      historyValidity: extra.historyValidity,
      policyAUnknownReason: extra.policyAUnknownReason,
    });
  }

  return picks.slice(0, 5);
}

async function main() {
  const cohort = await buildProductionWalletCohort();
  const unknownBreakdown: Record<UnknownBucket, number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
    E: 0,
  };
  const unknownMembers: Array<{
    wallet: string;
    bucket: UnknownBucket;
    policyAUnknownReason: string | null;
    historyValidity: string | null;
    completedPositions: number | null;
  }> = [];

  const truncationBlocked: ProductionWalletCohortMember[] = [];

  for (const member of cohort.wallets) {
    if (member.policyADecision !== "UNKNOWN") continue;
    const reasons = await loadMetricsReasons(member.wallet);
    const bucket = classifyUnknownBucket(member, reasons);
    unknownBreakdown[bucket] += 1;
    unknownMembers.push({
      wallet: member.wallet,
      bucket,
      policyAUnknownReason: member.policyAUnknownReason,
      historyValidity: member.historyValidity,
      completedPositions: member.completedPositions,
    });
    if (bucket === "B") truncationBlocked.push(member);
  }

  const truncationAnalyses = [];
  for (const member of truncationBlocked) {
    truncationAnalyses.push(await analyzeTruncationWallet(member.wallet));
  }

  const semanticsAloneCount = truncationAnalyses.filter(
    (row) => row.semanticsAloneWouldBeMetricsSafe
  ).length;
  const needsEarlierCount = truncationAnalyses.filter(
    (row) => row.needsEarlierVerifiedChainIndexing
  ).length;

  const passControl = cohort.wallets.filter((m) => m.policyADecision === "PASS");
  const pilotCohort = pickPilotCohort({
    semanticsAlone: truncationAnalyses,
    needsEarlier: truncationAnalyses,
    passControl,
    truncationBlocked,
  });

  const recommendation =
    cohort.policyAPass > 0 && pilotCohort.length >= 3 ? "READY_FOR_SMALL_BATCH" : "FIX_REQUIRED";

  console.log(
    JSON.stringify(
      {
        mode: "policy_a_post_d27c_cohort_checkpoint",
        generatedAt: new Date().toISOString(),
        cohort: {
          totalWallets: cohort.totalWallets,
          policyAPass: cohort.policyAPass,
          policyAFail: cohort.policyAFail,
          policyAUnknown: cohort.policyAUnknown,
          unknownBreakdown: {
            A_safe_history_lt10_completed: unknownBreakdown.A,
            B_truncation_blocked: unknownBreakdown.B,
            C_identity_blocked: unknownBreakdown.C,
            D_no_indexed_history: unknownBreakdown.D,
            E_other_unsafe: unknownBreakdown.E,
          },
          unknownMembers,
        },
        truncationImpact: {
          truncationBlockedWalletCount: truncationBlocked.length,
          likelyFixedBySourceSpecificSemanticsAlone: semanticsAloneCount,
          requiringEarlierVerifiedChainIndexing: needsEarlierCount,
          analyses: truncationAnalyses,
        },
        pilotCohort,
        recommendation,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
