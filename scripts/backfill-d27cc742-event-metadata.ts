#!/usr/bin/env tsx
/**
 * Backfill missing log_index / timestamp metadata for d27cc742 persisted events.
 * Read-only audit reconstruction + targeted metadata enrichment only.
 */
import "../tests/preload-env";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  walletHistoricalMetrics,
  walletLedgerEvents,
} from "@/lib/crossmarket/store/schema";
import {
  hasFullCanonicalChainOrder,
  sortLedgerEventsCanonical,
} from "@/lib/walletLedger/eventOrder";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { runIndexedWalletAudit } from "@/lib/walletLedger/indexed/pipeline";
import {
  countPersistedEventMetadataCoverage,
  enrichPersistedLedgerEventMetadata,
} from "@/lib/walletLedger/indexed/store/eventMetadataEnrichment";
import { loadPersistedLifecycleRows } from "@/lib/walletLedger/indexed/store/incrementalLifecycles";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";

const WALLET = "0xd27cc742d023d06ef633a4c880cf1ff1836ec081";

function closeEnough(a: number | null | undefined, b: number | null | undefined, tol: number) {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) <= tol;
}

function nullLogIndexCondition() {
  return or(
    isNull(walletLedgerEvents.logIndex),
    eq(walletLedgerEvents.logIndex, "")
  );
}

async function classifyRemainingNullLogIndex(wallet: string) {
  const db = getDb();
  const walletAddress = wallet.toLowerCase();
  const rows = await db
    .select({
      source: walletLedgerEvents.source,
      eventType: walletLedgerEvents.eventType,
      blockNumber: walletLedgerEvents.blockNumber,
      txHash: walletLedgerEvents.txHash,
    })
    .from(walletLedgerEvents)
    .where(
      and(eq(walletLedgerEvents.walletAddress, walletAddress), nullLogIndexCondition())
    )
    .limit(5000);

  const [missing] = await db
    .select({
      total: sql<number>`count(*)::int`,
    })
    .from(walletLedgerEvents)
    .where(
      and(eq(walletLedgerEvents.walletAddress, walletAddress), nullLogIndexCondition())
    );

  const bySource: Record<string, number> = {};
  let polygonWithoutBlock = 0;
  for (const row of rows) {
    bySource[row.source] = (bySource[row.source] ?? 0) + 1;
    if (row.source === "polygon" && (row.blockNumber ?? 0) <= 0) {
      polygonWithoutBlock += 1;
    }
  }

  const apiSources = Object.entries(bySource)
    .filter(([source]) => source !== "polygon")
    .reduce((sum, [, count]) => sum + count, 0);

  return {
    sampledRows: rows.length,
    remainingNullLogIndex: missing?.total ?? 0,
    bySource,
    polygonWithoutBlockInSample: polygonWithoutBlock,
    interpretation: {
      apiOnlyEvents:
        "Non-polygon persisted rows (activity/trades API) never carry chain logIndex",
      polygonWithoutLogIndex:
        "Polygon rows still null after backfill — incoming reconstruction lacked logIndex or row unmatched",
      syntheticOrLegacy:
        "Rows with null blockNumber/txHash may be legacy normalized API events",
    },
    apiSourceCountInSample: apiSources,
    polygonSourceCountInSample: bySource.polygon ?? 0,
  };
}

async function rebuildMetricsFromPersistedEvents(wallet: string) {
  const events = sortLedgerEventsCanonical(await loadPersistedWalletEvents(wallet));
  const { positions } = await buildPositionLifecycles(wallet, events);
  const mergeSplit = analyzeMergeSplitImpact(positions);
  const metrics = computeWalletLedgerMetrics({
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
  const verdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: metrics.credibilityMetricsValid,
    historyValidity: metrics.historyValidity,
    completedPositionCount: metrics.completedPositionCount,
    realizedRoi: metrics.portfolioRealizedRoi,
    profitablePositionRate: metrics.profitablePositionRate,
    metricVersion: WALLET_METRIC_VERSION,
  });
  return {
    events,
    positions,
    metrics,
    policyAVerdict: verdict.historicalPerformanceDecision,
    withLogIndex: events.filter((event) => event.logIndex != null).length,
    withFullChainOrder: events.filter((event) => hasFullCanonicalChainOrder(event)).length,
  };
}

async function main() {
  const beforeCoverage = await countPersistedEventMetadataCoverage(WALLET);

  const audit = await runIndexedWalletAudit({
    label: "backfill-d27cc742-event-metadata",
    wallet: WALLET,
    providerId: "etherscan_v2",
    fullHistory: true,
    resumeCheckpoint: false,
    allowEarlierThanIncremental: true,
  });

  const authoritativeEvents = audit.authoritativeIndexedEvents ?? [];
  const incomingWithLogIndex = authoritativeEvents.filter(
    (event) => event.logIndex != null && event.logIndex >= 0
  ).length;

  const enrichment = await enrichPersistedLedgerEventMetadata(
    WALLET,
    authoritativeEvents
  );
  const afterCoverage = await countPersistedEventMetadataCoverage(WALLET);
  const remainingTaxonomy = await classifyRemainingNullLogIndex(WALLET);

  const db = getDb();
  const [durableMetrics] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, WALLET.toLowerCase()),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);

  const persistedLifecycles = await loadPersistedLifecycleRows(WALLET);
  const reload = await rebuildMetricsFromPersistedEvents(WALLET);

  const completedDelta =
    (reload.metrics.completedPositionCount ?? 0) -
    (durableMetrics?.completedPositions ?? 0);
  const roiDelta =
    (reload.metrics.portfolioRealizedRoi ?? 0) - (durableMetrics?.realizedRoi ?? 0);
  const profitableDelta =
    (reload.metrics.profitablePositionRate ?? 0) -
    (durableMetrics?.profitablePositionRate ?? 0);
  const episodeDelta = reload.positions.length - persistedLifecycles.length;

  const reloadMatchesDurable =
    completedDelta === 0 &&
    closeEnough(reload.metrics.portfolioRealizedRoi, durableMetrics?.realizedRoi, 0.002) &&
    closeEnough(
      reload.metrics.profitablePositionRate,
      durableMetrics?.profitablePositionRate,
      0.01
    ) &&
    reload.policyAVerdict === "PASS" &&
    durableMetrics?.completedPositions === 342;

  const recommendation = reloadMatchesDurable ? "READY_FOR_SMALL_BATCH" : "FIX_REQUIRED";

  console.log(
    JSON.stringify(
      {
        mode: "backfill_d27cc742_event_metadata",
        wallet: WALLET,
        backfill: {
          rowsBefore: beforeCoverage.total,
          withLogIndexBefore: beforeCoverage.withLogIndex,
          incomingReconstructedEvents: authoritativeEvents.length,
          incomingWithLogIndex,
          existingRowsMatched: enrichment.existingRowsMatched,
          logIndexBackfills: enrichment.logIndexBackfills,
          timestampBackfills: enrichment.timestampBackfills,
          blockNumberBackfills: enrichment.blockNumberBackfills,
          metadataConflicts: enrichment.metadataConflicts,
          rowsUnchanged: enrichment.rowsUnchanged,
          conflictSamples: enrichment.conflictSamples,
          afterCoverage,
          remainingNullLogIndexTaxonomy: remainingTaxonomy,
        },
        reloadValidation: {
          durable: {
            completedPositions: durableMetrics?.completedPositions,
            realizedRoi: durableMetrics?.realizedRoi,
            profitablePositionRate: durableMetrics?.profitablePositionRate,
            policyAVerdict: "PASS",
            lifecycleEpisodes: persistedLifecycles.length,
            completedLifecycles: persistedLifecycles.filter((row) => row.completed)
              .length,
          },
          rebuiltFromPersistedEvents: {
            completedPositions: reload.metrics.completedPositionCount,
            realizedRoi: reload.metrics.portfolioRealizedRoi,
            profitablePositionRate: reload.metrics.profitablePositionRate,
            policyAVerdict: reload.policyAVerdict,
            lifecycleEpisodes: reload.positions.length,
            completedLifecycles: reload.positions.filter((row) => row.completed).length,
            eventsWithLogIndex: reload.withLogIndex,
            eventsWithFullChainOrder: reload.withFullChainOrder,
          },
          deltas: {
            completedPositions: completedDelta,
            realizedRoi: roiDelta,
            profitablePositionRate: profitableDelta,
            lifecycleEpisodes: episodeDelta,
          },
          reloadMatchesDurable,
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
