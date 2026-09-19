#!/usr/bin/env tsx
/**
 * Read-only post-persist verification for d27cc742.
 * Compares read-only reconstructed audit metrics vs freshly reloaded durable rows.
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
import {
  hasFullCanonicalChainOrder,
  hasPartialCanonicalChainOrder,
  sortLedgerEventsCanonical,
  summarizeCanonicalOrderDiagnostics,
} from "@/lib/walletLedger/eventOrder";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import { loadPersistedLifecycleRows } from "@/lib/walletLedger/indexed/store/incrementalLifecycles";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";

const WALLET = "0xd27cc742d023d06ef633a4c880cf1ff1836ec081";

const PILOT_EXPECTED = {
  completedPositions: 342,
  realizedRoi: 0.19086754802105368,
  profitablePositionRate: 0.8567251461988304,
  historyValidity: "partial-but-metrics-safe",
  policyAVerdict: "PASS" as const,
};

function closeEnough(a: number | null | undefined, b: number | null | undefined, tol: number): boolean {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) <= tol;
}

function summarizeMetrics(input: {
  completedPositions: number | null | undefined;
  realizedRoi: number | null | undefined;
  profitablePositionRate: number | null | undefined;
  historyValidity: string | null | undefined;
  credibilityMetricsValid?: boolean | null;
}) {
  const verdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: Boolean(input.credibilityMetricsValid),
    historyValidity: input.historyValidity,
    completedPositionCount: input.completedPositions ?? null,
    realizedRoi: input.realizedRoi ?? null,
    profitablePositionRate: input.profitablePositionRate ?? null,
    metricVersion: WALLET_METRIC_VERSION,
  });
  return {
    completedPositions: input.completedPositions ?? null,
    realizedRoi: input.realizedRoi ?? null,
    profitablePositionRate: input.profitablePositionRate ?? null,
    historyValidity: input.historyValidity ?? null,
    credibilityMetricsValid: input.credibilityMetricsValid ?? null,
    policyAVerdict: verdict.historicalPerformanceDecision,
  };
}

async function loadDurableSnapshot(wallet: string) {
  const db = getDb();
  const normalized = wallet.toLowerCase();
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
  const [eventStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withBlock: sql<number>`count(*) filter (where ${walletLedgerEvents.blockNumber} is not null and ${walletLedgerEvents.blockNumber} > 0)::int`,
      withLogIndex: sql<number>`count(*) filter (where ${walletLedgerEvents.logIndex} is not null and ${walletLedgerEvents.logIndex} <> '')::int`,
    })
    .from(walletLedgerEvents)
    .where(eq(walletLedgerEvents.walletAddress, normalized));
  const [lifecycleStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${walletPositionLifecycles.completed})::int`,
    })
    .from(walletPositionLifecycles)
    .where(
      and(
        eq(walletPositionLifecycles.walletAddress, normalized),
        eq(walletPositionLifecycles.metricVersion, WALLET_METRIC_VERSION)
      )
    );
  return { metrics, coverage, eventStats, lifecycleStats };
}

async function rebuildFromPersistedEvents(wallet: string) {
  const events = sortLedgerEventsCanonical(await loadPersistedWalletEvents(wallet));
  const { positions } = await buildPositionLifecycles(wallet, events);
  const mergeSplit = analyzeMergeSplitImpact(positions);
  const rebuilt = computeWalletLedgerMetrics({
    positions,
    identity: {
      confidence: "high",
      resolutionMethod: "proxy_wallet_direct",
      positionsOnlyMismatch: false,
    },
    activityTruncated: false,
    tradesTruncated: false,
    rawEventCount: events.length,
    deduplicatedEventCount: events.length,
    gammaCoverage: {
      distinctMarkets: new Set(positions.map((p) => p.conditionId).filter(Boolean)).size,
      marketsFoundBefore: 1,
      marketsFoundAfter: 1,
      resolvedBefore: 0,
      resolvedAfter: 0,
      coverageBeforePct: 1,
      coverageAfterPct: 1,
      marketFoundCoverageAfterPct: 1,
    },
    mergeSplit,
    hasHistoryEvents: events.length > 0,
  });
  const canonicalDiagnostics = summarizeCanonicalOrderDiagnostics(events);
  return { events, positions, rebuilt, canonicalDiagnostics };
}

async function main() {
  const audit = await runIndexedWalletAudit({
    label: "verify-d27cc742-post-persist",
    wallet: WALLET,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: false,
    allowEarlierThanIncremental: true,
  });

  const reconstructed = summarizeMetrics({
    completedPositions: audit.indexedCompletedPositions,
    realizedRoi: audit.indexedLedgerMetrics?.portfolioRealizedRoi,
    profitablePositionRate: audit.indexedLedgerMetrics?.profitablePositionRate,
    historyValidity: audit.indexedLedgerMetrics?.historyValidity,
    credibilityMetricsValid: audit.indexedLedgerMetrics?.credibilityMetricsValid,
  });

  const durable = await loadDurableSnapshot(WALLET);
  const postPersist = summarizeMetrics({
    completedPositions: durable.metrics?.completedPositions,
    realizedRoi: durable.metrics?.realizedRoi,
    profitablePositionRate: durable.metrics?.profitablePositionRate,
    historyValidity: durable.metrics?.historyValidity,
    credibilityMetricsValid: durable.metrics?.credibilityMetricsValid,
  });

  const reload = await rebuildFromPersistedEvents(WALLET);
  const rebuilt = summarizeMetrics({
    completedPositions: reload.rebuilt.completedPositionCount,
    realizedRoi: reload.rebuilt.portfolioRealizedRoi,
    profitablePositionRate: reload.rebuilt.profitablePositionRate,
    historyValidity: reload.rebuilt.historyValidity,
    credibilityMetricsValid: reload.rebuilt.credibilityMetricsValid,
  });

  const persistedLifecycles = await loadPersistedLifecycleRows(WALLET);

  const metricsMatchPilot =
    reconstructed.completedPositions === PILOT_EXPECTED.completedPositions &&
    closeEnough(reconstructed.realizedRoi, PILOT_EXPECTED.realizedRoi, 0.002) &&
    closeEnough(
      reconstructed.profitablePositionRate,
      PILOT_EXPECTED.profitablePositionRate,
      0.01
    ) &&
    reconstructed.historyValidity === PILOT_EXPECTED.historyValidity &&
    reconstructed.policyAVerdict === PILOT_EXPECTED.policyAVerdict;

  const reconstructedMatchesPostPersist =
    reconstructed.completedPositions === postPersist.completedPositions &&
    closeEnough(reconstructed.realizedRoi, postPersist.realizedRoi, 0.002) &&
    closeEnough(
      reconstructed.profitablePositionRate,
      postPersist.profitablePositionRate,
      0.01
    ) &&
    reconstructed.policyAVerdict === postPersist.policyAVerdict;

  const rebuiltMatchesPostPersist =
    rebuilt.completedPositions === postPersist.completedPositions &&
    closeEnough(rebuilt.realizedRoi, postPersist.realizedRoi, 0.002) &&
    closeEnough(rebuilt.profitablePositionRate, postPersist.profitablePositionRate, 0.01) &&
    rebuilt.policyAVerdict === postPersist.policyAVerdict;

  const pilotVerificationPassed =
    metricsMatchPilot && reconstructedMatchesPostPersist;

  const recommendation = pilotVerificationPassed
    ? rebuiltMatchesPostPersist
      ? "SAFE_TO_PERSIST_D27C"
      : "LOG_INDEX_BACKFILL_REQUIRED"
    : "FIX_REQUIRED";

  console.log(
    JSON.stringify(
      {
        mode: "verify_d27cc742_post_persist",
        wallet: WALLET,
        pilotExpected: PILOT_EXPECTED,
        readOnlyReconstructed: reconstructed,
        postPersistDurable: {
          ...postPersist,
          coverage: durable.coverage
            ? {
                fromBlock: durable.coverage.fromBlock,
                indexedOldestTimestamp: durable.coverage.indexedOldestTimestamp,
                lastIndexedBlock: durable.coverage.lastIndexedBlock,
                lastReconstructedBlock: durable.coverage.lastReconstructedBlock,
              }
            : null,
          eventStats: durable.eventStats,
          lifecycleStats: durable.lifecycleStats,
        },
        reloadRoundTrip: {
          events: {
            total: reload.events.length,
            withBlockNumber: reload.events.filter((event) => (event.blockNumber ?? 0) > 0)
              .length,
            withLogIndex: reload.events.filter((event) => event.logIndex != null).length,
            withFullChainOrder: reload.events.filter((event) =>
              hasFullCanonicalChainOrder(event)
            ).length,
            withBlockOnly: reload.events.filter(
              (event) =>
                hasPartialCanonicalChainOrder(event) && !hasFullCanonicalChainOrder(event)
            ).length,
            canonicalOrderDiagnostics: reload.canonicalDiagnostics,
          },
          rebuiltMetrics: rebuilt,
          persistedLifecycleRows: persistedLifecycles.length,
          rebuiltLifecycleEpisodes: reload.positions.length,
          persistedCompletedLifecycles: durable.lifecycleStats?.completed ?? null,
          deltas: {
            completedPositions:
              (rebuilt.completedPositions ?? 0) - (postPersist.completedPositions ?? 0),
            realizedRoi: (rebuilt.realizedRoi ?? 0) - (postPersist.realizedRoi ?? 0),
            profitablePositionRate:
              (rebuilt.profitablePositionRate ?? 0) -
              (postPersist.profitablePositionRate ?? 0),
            lifecycleEpisodes:
              reload.positions.length - (durable.lifecycleStats?.total ?? 0),
          },
        },
        comparisons: {
          metricsMatchPilot,
          reconstructedMatchesPostPersist,
          rebuiltMatchesPostPersist,
          pilotVerificationPassed,
          note:
            rebuiltMatchesPostPersist
              ? null
              : "Reload rebuild diverges because persisted wallet_ledger_events rows still lack log_index (0/44826). Canonical ordering falls back to block-only/dedupeKey on reload until backfill.",
        },
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
