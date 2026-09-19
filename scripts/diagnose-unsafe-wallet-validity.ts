#!/usr/bin/env tsx
/**
 * Read-only validity diagnosis for Policy A coverage wallets.
 * No network hydration — DB + offline lifecycle rebuild only.
 */
import "../tests/preload-env";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletHistoryCoverage,
  walletLedgerEvents,
  walletPositionLifecycles,
} from "@/lib/crossmarket/store/schema";
import { computeIndexedBoundaryStats } from "@/lib/walletLedger/indexed/authoritativeEvents";
import { explainHistoryCompleteness } from "@/lib/walletLedger/indexed/metricsProfile";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import { computeResolutionCoverage } from "@/lib/walletLedger/validity";

const TARGET_WALLETS = [
  "0xd27cc742d023d06ef633a4c880cf1ff1836ec081",
  "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
  "0x9e3ed7b661a903fc97afcf49e0f014ebe869f882",
];

function iso(ts: number | null | undefined): string | null {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts * 1000).toISOString();
}

function classifyUnsafeCause(input: {
  reasons: string[];
  timestampNullPct: number;
  extendsBeforeApiBoundary: boolean;
  eventsBeforeApiBoundary: number;
  offlineBoundaryEvents: number;
  mergeSplitUnresolved: boolean;
  mergeSplitMaterial: boolean;
  gammaIncomplete: boolean;
}): "A" | "B" | "C" | "D" {
  if (
    input.reasons.includes("activity_truncated") ||
    input.reasons.includes("trades_truncated")
  ) {
    if (
      input.timestampNullPct > 0 ||
      (input.offlineBoundaryEvents === 0 && input.eventsBeforeApiBoundary === 0)
    ) {
      return "A";
    }
    return "B";
  }
  if (input.mergeSplitMaterial || input.mergeSplitUnresolved) return "C";
  if (
    input.reasons.includes("gamma_resolution_incomplete") ||
    input.reasons.includes("gamma_resolution_missing_on_held_positions")
  ) {
    return "D";
  }
  if (
    input.reasons.some((r) =>
      r.startsWith("identity_") || r === "positions_without_history_events"
    )
  ) {
    return "D";
  }
  return "D";
}

async function queryEventStats(wallet: string) {
  const db = getDb();
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      nullTs: sql<number>`count(*) filter (where ${walletLedgerEvents.blockTimestamp} is null)::int`,
      usableTs: sql<number>`count(*) filter (where ${walletLedgerEvents.blockTimestamp} is not null and ${walletLedgerEvents.blockTimestamp} > 0)::int`,
      minBlock: sql<number | null>`min(${walletLedgerEvents.blockNumber})`,
      maxBlock: sql<number | null>`max(${walletLedgerEvents.blockNumber})`,
      minTs: sql<number | null>`min(${walletLedgerEvents.blockTimestamp}) filter (where ${walletLedgerEvents.blockTimestamp} is not null and ${walletLedgerEvents.blockTimestamp} > 0)`,
      maxTs: sql<number | null>`max(${walletLedgerEvents.blockTimestamp}) filter (where ${walletLedgerEvents.blockTimestamp} is not null and ${walletLedgerEvents.blockTimestamp} > 0)`,
      distinctBlocks: sql<number>`count(distinct ${walletLedgerEvents.blockNumber})::int`,
      blocksMissingTs: sql<number>`count(distinct ${walletLedgerEvents.blockNumber}) filter (where ${walletLedgerEvents.blockTimestamp} is null)::int`,
    })
    .from(walletLedgerEvents)
    .where(eq(walletLedgerEvents.walletAddress, wallet));

  const total = row?.total ?? 0;
  const usableTs = row?.usableTs ?? 0;
  return {
    totalRows: total,
    blockTimestampNull: row?.nullTs ?? 0,
    usableTimestampRows: usableTs,
    usableTimestampPct: total > 0 ? usableTs / total : 0,
    minBlock: row?.minBlock ?? null,
    maxBlock: row?.maxBlock ?? null,
    minUsableTimestamp: row?.minTs ?? null,
    maxUsableTimestamp: row?.maxTs ?? null,
    minUsableTimestampIso: iso(row?.minTs ?? null),
    maxUsableTimestampIso: iso(row?.maxTs ?? null),
    distinctBlocks: row?.distinctBlocks ?? 0,
    distinctBlocksMissingTimestamp: row?.blocksMissingTs ?? 0,
  };
}

async function diagnoseWallet(wallet: string) {
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

  const lifecycleStats = await db
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${walletPositionLifecycles.completed})::int`,
      excluded: sql<number>`count(*) filter (where ${walletPositionLifecycles.exclusionReason} is not null)::int`,
      mergeSplitExcluded: sql<number>`count(*) filter (where ${walletPositionLifecycles.exclusionReason} = 'requires_merge_split_resolution')::int`,
      invalidAccounting: sql<number>`count(*) filter (where ${walletPositionLifecycles.exclusionReason} = 'invalid_capital_accounting')::int`,
    })
    .from(walletPositionLifecycles)
    .where(
      and(
        eq(walletPositionLifecycles.walletAddress, normalized),
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    );

  const eventStats = await queryEventStats(normalized);
  const events = await loadPersistedWalletEvents(normalized);
  const { positions } = await buildPositionLifecycles(normalized, events);
  const mergeSplit = analyzeMergeSplitImpact(positions);
  const resolutionCoverage = computeResolutionCoverage(positions);

  const eventsWithTs = events.filter((e) => e.timestamp > 0);
  const offlineBoundary = computeIndexedBoundaryStats(
    eventsWithTs,
    coverage?.apiOldestTimestamp ?? null
  );

  const offlineMetrics = computeWalletLedgerMetrics({
    positions,
    identity: {
      confidence: "high",
      resolutionMethod: "proxy_wallet",
      positionsOnlyMismatch: false,
    },
    activityTruncated: (metrics?.historyIncompleteReasons ?? []).includes(
      "activity_truncated"
    ),
    tradesTruncated: (metrics?.historyIncompleteReasons ?? []).includes(
      "trades_truncated"
    ),
    rawEventCount: events.length,
    deduplicatedEventCount: events.length,
    gammaCoverage: {
      distinctMarkets: new Set(positions.map((p) => p.conditionId).filter(Boolean))
        .size,
      marketsFoundBefore: 0,
      marketsFoundAfter: 0,
      resolvedBefore: 0,
      resolvedAfter: 0,
      coverageBeforePct: 1,
      coverageAfterPct: 1,
      marketFoundCoverageAfterPct: 1,
    },
    mergeSplit,
    hasHistoryEvents: events.length > 0,
  });

  const reasons = metrics?.historyIncompleteReasons ?? [];
  const cause = classifyUnsafeCause({
    reasons,
    timestampNullPct: 1 - eventStats.usableTimestampPct,
    extendsBeforeApiBoundary: coverage?.extendsBeforeApiBoundary ?? false,
    eventsBeforeApiBoundary: coverage?.eventsBeforeApiBoundary ?? 0,
    offlineBoundaryEvents: offlineBoundary.eventsBeforeApiBoundary,
    mergeSplitUnresolved: reasons.includes("merge_split_unresolved"),
    mergeSplitMaterial: reasons.includes("merge_split_material"),
    gammaIncomplete: reasons.includes("gamma_resolution_incomplete"),
  });

  const truncationImmunityAttempted =
    (coverage?.extendsBeforeApiBoundary ?? false) ||
    (coverage?.eventsBeforeApiBoundary ?? 0) > 0 ||
    offlineBoundary.eventsBeforeApiBoundary > 0;

  const truncationImmunityGranted =
    !(reasons.includes("activity_truncated") || reasons.includes("trades_truncated"));

  return {
    wallet: normalized,
    persistedMetrics: metrics
      ? {
          completedPositions: metrics.completedPositions,
          credibilityMetricsValid: metrics.credibilityMetricsValid,
          historyValidity: metrics.historyValidity,
          historyComplete: metrics.historyComplete,
          historyCompletenessReasons: metrics.historyIncompleteReasons ?? [],
          credibilityReasons: metrics.credibilityReasons ?? [],
          realizedRoi: metrics.realizedRoi,
          profitablePositionRate: metrics.profitablePositionRate,
          throughBlock: metrics.throughBlock,
          calculatedAt: metrics.calculatedAt?.toISOString(),
        }
      : null,
    persistedCoverage: coverage
      ? {
          provider: coverage.provider,
          metricVersion: coverage.metricVersion,
          chainId: coverage.chainId,
          fromBlock: coverage.fromBlock,
          lastIndexedBlock: coverage.lastIndexedBlock,
          lastReconstructedBlock: coverage.lastReconstructedBlock,
          apiOldestTimestamp: coverage.apiOldestTimestamp,
          apiOldestTimestampIso: iso(coverage.apiOldestTimestamp),
          indexedOldestTimestamp: coverage.indexedOldestTimestamp,
          indexedOldestTimestampIso: iso(coverage.indexedOldestTimestamp),
          extendsBeforeApiBoundary: coverage.extendsBeforeApiBoundary,
          eventsBeforeApiBoundary: coverage.eventsBeforeApiBoundary,
          eventHistoryComplete: coverage.eventHistoryComplete,
          identityComplete: coverage.identityComplete,
          resolutionComplete: coverage.resolutionComplete,
          historyComplete: coverage.historyComplete,
          historyValidity: coverage.historyValidity,
          timestampCoveragePct: coverage.timestampCoveragePct,
          timestampMissingBlocks: coverage.timestampMissingBlocks,
          gammaResolutionIncomplete: coverage.gammaResolutionIncomplete,
          mergeSplitUnresolved: coverage.mergeSplitUnresolved,
        }
      : null,
    truncationFlags: {
      activityTruncated: reasons.includes("activity_truncated"),
      tradesTruncated: reasons.includes("trades_truncated"),
      truncationImmunityAttempted,
      truncationImmunityGranted,
      offlineRecomputedBoundary: offlineBoundary,
      timestampBackfillWouldHelp:
        eventStats.blockTimestampNull > 0 &&
        offlineBoundary.eventsBeforeApiBoundary === 0 &&
        (coverage?.eventsBeforeApiBoundary ?? 0) === 0,
    },
    eventStats,
    lifecycleStats: lifecycleStats[0] ?? null,
    offlineReconstruction: {
      eventCount: events.length,
      eventsWithPositiveTimestamp: eventsWithTs.length,
      positionCount: positions.length,
      completedPositions: positions.filter((p) => p.completed).length,
      credibleCompleted: positions.filter(
        (p) =>
          p.completed &&
          !p.excludedFromMetrics &&
          p.realizedPnl != null &&
          (p.completionReason === "fully_exited" ||
            p.resolution?.resolutionFinal === true)
      ).length,
      mergeSplit,
      resolutionCoverage,
      completenessBreakdown: explainHistoryCompleteness(offlineMetrics),
    },
    unsafeCauseClass: cause,
    unsafeCauseLabel:
      cause === "A"
        ? "timestamp/truncation-immunity infrastructure"
        : cause === "B"
          ? "genuinely incomplete/unsafe ledger"
          : cause === "C"
            ? "merge/split accounting"
            : "other (gamma/identity/etc)",
  };
}

async function cohortUnsafeBreakdown() {
  const db = getDb();
  const rows = await db
    .select({
      walletAddress: walletHistoricalMetrics.walletAddress,
      completedPositions: walletHistoricalMetrics.completedPositions,
      historyValidity: walletHistoricalMetrics.historyValidity,
      credibilityMetricsValid: walletHistoricalMetrics.credibilityMetricsValid,
      reasons: walletHistoricalMetrics.historyIncompleteReasons,
      extendsBeforeApi: walletHistoryCoverage.extendsBeforeApiBoundary,
      eventsBeforeApi: walletHistoryCoverage.eventsBeforeApiBoundary,
      timestampCoveragePct: walletHistoryCoverage.timestampCoveragePct,
      gammaIncomplete: walletHistoryCoverage.gammaResolutionIncomplete,
      mergeSplitUnresolved: walletHistoryCoverage.mergeSplitUnresolved,
    })
    .from(walletHistoricalMetrics)
    .leftJoin(
      walletHistoryCoverage,
      eq(walletHistoricalMetrics.walletAddress, walletHistoryCoverage.walletAddress)
    )
    .where(
      and(
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION),
        eq(walletHistoricalMetrics.historyValidity, "partial-and-metrics-unsafe")
      )
    );

  const reasonCounts = new Map<string, number>();
  let truncationOnly = 0;
  let mergeSplit = 0;
  let gamma = 0;
  let identity = 0;
  let noPreApi = 0;
  let nullTimestampPctZero = 0;

  for (const row of rows) {
    const reasons = row.reasons ?? [];
    for (const reason of reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
    if (
      reasons.includes("activity_truncated") ||
      reasons.includes("trades_truncated")
    ) {
      truncationOnly += 1;
      if ((row.eventsBeforeApi ?? 0) === 0 && !row.extendsBeforeApi) noPreApi += 1;
      if ((row.timestampCoveragePct ?? 1) < 1) nullTimestampPctZero += 1;
    }
    if (
      reasons.includes("merge_split_material") ||
      reasons.includes("merge_split_unresolved")
    ) {
      mergeSplit += 1;
    }
    if (reasons.includes("gamma_resolution_incomplete")) gamma += 1;
    if (reasons.some((r) => r.startsWith("identity_"))) identity += 1;
  }

  return {
    totalPartialAndMetricsUnsafe: rows.length,
    reasonCounts: Object.fromEntries(
      [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])
    ),
    truncationFlagged: truncationOnly,
    truncationWithNoPreApiImmunity: noPreApi,
    truncationWithIncompleteTimestampCoverage: nullTimestampPctZero,
    mergeSplitFlagged: mergeSplit,
    gammaFlagged: gamma,
    identityFlagged: identity,
    sampleWallets: rows.slice(0, 8).map((r) => ({
      wallet: r.walletAddress,
      completed: r.completedPositions,
      reasons: r.reasons,
      eventsBeforeApi: r.eventsBeforeApi,
      timestampCoveragePct: r.timestampCoveragePct,
    })),
  };
}

async function main() {
  const wallets = await Promise.all(TARGET_WALLETS.map((w) => diagnoseWallet(w)));
  const cohort = await cohortUnsafeBreakdown();
  console.log(
    JSON.stringify(
      {
        mode: "unsafe_wallet_validity_diagnosis",
        wallets,
        cohortUnsafeBreakdown: cohort,
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
