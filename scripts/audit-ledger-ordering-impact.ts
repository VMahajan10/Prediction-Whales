#!/usr/bin/env tsx
/**
 * Read-only impact audit: timestamp-only vs canonical chain-order replay.
 */
import "../tests/preload-env";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import {
  policyAProductionWalletHydration,
  walletHistoricalMetrics,
} from "@/lib/crossmarket/store/schema";
import { sortLedgerEventsCanonical } from "@/lib/walletLedger/eventOrder";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import { positionKey } from "@/lib/walletLedger/normalize";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

function sortByTimestampOnly(events: WalletLedgerEvent[]): WalletLedgerEvent[] {
  return [...events].sort((a, b) => a.timestamp - b.timestamp);
}

async function sampleWallets(
  policyDecision: "PASS" | "FAIL",
  limit: number
): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ wallet: policyAProductionWalletHydration.walletAddress })
    .from(policyAProductionWalletHydration)
    .where(eq(policyAProductionWalletHydration.policyADecision, policyDecision))
    .orderBy(desc(policyAProductionWalletHydration.updatedAt))
    .limit(limit * 3);
  const unique = [...new Set(rows.map((row) => row.wallet.toLowerCase()))];
  if (unique.length >= limit) {
    return unique.slice(0, limit);
  }

  const fallbackRows = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION),
        eq(walletHistoricalMetrics.credibilityMetricsValid, true)
      )
    )
    .orderBy(desc(walletHistoricalMetrics.updatedAt))
    .limit(300);
  for (const row of fallbackRows) {
    const verdict = evaluateHistoricalPerformanceVerdict({
      indexedDataValidity: row.credibilityMetricsValid,
      historyValidity: row.historyValidity,
      historyComplete: row.historyComplete,
      completedPositionCount: row.completedPositions,
      realizedRoi: row.realizedRoi,
      profitablePositionRate: row.profitablePositionRate,
      metricVersion: row.metricVersion,
    });
    if (verdict.historicalPerformanceDecision !== policyDecision) continue;
    const wallet = row.walletAddress.toLowerCase();
    if (!unique.includes(wallet)) unique.push(wallet);
    if (unique.length >= limit) break;
  }
  return unique.slice(0, limit);
}

async function sampleMetricsSafeWallets(limit: number): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ wallet: walletHistoricalMetrics.walletAddress })
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION),
        eq(walletHistoricalMetrics.historyValidity, "partial-but-metrics-safe")
      )
    )
    .limit(limit * 3);
  const unique = [...new Set(rows.map((row) => row.wallet.toLowerCase()))];
  return unique.slice(0, limit);
}

function countMixedTimestampGroups(events: WalletLedgerEvent[]): number {
  const groups = new Map<string, { zero: number; valid: number }>();
  for (const event of events) {
    if (!event.conditionId && !event.asset) continue;
    const key = positionKey(event);
    const group = groups.get(key) ?? { zero: 0, valid: 0 };
    if (!event.timestamp || event.timestamp <= 0) group.zero += 1;
    else group.valid += 1;
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.zero > 0 && group.valid > 0)
    .length;
}

async function compareWallet(wallet: string) {
  const events = await loadPersistedWalletEvents(wallet);
  if (events.length === 0) {
    return { wallet, skipped: true, reason: "no_persisted_events" };
  }

  const timestampLifecycle = await buildPositionLifecycles(
    wallet,
    sortByTimestampOnly(events)
  );
  const canonicalLifecycle = await buildPositionLifecycles(
    wallet,
    sortLedgerEventsCanonical(events)
  );

  const timestampMetrics = computeWalletLedgerMetrics({
    positions: timestampLifecycle.positions,
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
      distinctMarkets: 1,
      marketsFoundBefore: 1,
      marketsFoundAfter: 1,
      resolvedBefore: 0,
      resolvedAfter: 0,
      coverageBeforePct: 1,
      coverageAfterPct: 1,
      marketFoundCoverageAfterPct: 1,
    },
    mergeSplit: { mergeSplitImpact: false, mergeSplitPositionCount: 0 },
    hasHistoryEvents: true,
  });
  const canonicalMetrics = computeWalletLedgerMetrics({
    positions: canonicalLifecycle.positions,
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
      distinctMarkets: 1,
      marketsFoundBefore: 1,
      marketsFoundAfter: 1,
      resolvedBefore: 0,
      resolvedAfter: 0,
      coverageBeforePct: 1,
      coverageAfterPct: 1,
      marketFoundCoverageAfterPct: 1,
    },
    mergeSplit: { mergeSplitImpact: false, mergeSplitPositionCount: 0 },
    hasHistoryEvents: true,
  });

  const timestampVerdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: timestampMetrics.credibilityMetricsValid,
    historyValidity: timestampMetrics.historyValidity,
    historyComplete: timestampMetrics.historyComplete,
    completedPositionCount: timestampMetrics.completedPositionCount,
    realizedRoi: timestampMetrics.portfolioRealizedRoi,
    profitablePositionRate: timestampMetrics.profitablePositionRate,
    metricVersion: WALLET_METRIC_VERSION,
  });
  const canonicalVerdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: canonicalMetrics.credibilityMetricsValid,
    historyValidity: canonicalMetrics.historyValidity,
    historyComplete: canonicalMetrics.historyComplete,
    completedPositionCount: canonicalMetrics.completedPositionCount,
    realizedRoi: canonicalMetrics.portfolioRealizedRoi,
    profitablePositionRate: canonicalMetrics.profitablePositionRate,
    metricVersion: WALLET_METRIC_VERSION,
  });

  const episodeDelta =
    canonicalLifecycle.positions.length - timestampLifecycle.positions.length;
  const completedDelta =
    canonicalMetrics.completedPositionCount -
    timestampMetrics.completedPositionCount;
  const roiDelta =
    (canonicalMetrics.portfolioRealizedRoi ?? 0) -
    (timestampMetrics.portfolioRealizedRoi ?? 0);

  return {
    wallet,
    skipped: false,
    persistedEvents: events.length,
    mixedTimestampGroups: countMixedTimestampGroups(events),
    eventsWithLogIndex: events.filter((event) => event.logIndex != null).length,
    timestampOrdering: {
      lifecycleEpisodes: timestampLifecycle.positions.length,
      completedPositions: timestampMetrics.completedPositionCount,
      realizedRoi: timestampMetrics.portfolioRealizedRoi,
      profitablePositionRate: timestampMetrics.profitablePositionRate,
      policyA: timestampVerdict.historicalPerformanceDecision,
    },
    canonicalOrdering: {
      lifecycleEpisodes: canonicalLifecycle.positions.length,
      completedPositions: canonicalMetrics.completedPositionCount,
      realizedRoi: canonicalMetrics.portfolioRealizedRoi,
      profitablePositionRate: canonicalMetrics.profitablePositionRate,
      policyA: canonicalVerdict.historicalPerformanceDecision,
    },
    deltas: {
      lifecycleEpisodes: episodeDelta,
      completedPositions: completedDelta,
      realizedRoi: roiDelta,
      policyAChanged:
        timestampVerdict.historicalPerformanceDecision !==
        canonicalVerdict.historicalPerformanceDecision,
    },
    materialChange:
      Math.abs(completedDelta) > 2 ||
      Math.abs(roiDelta) > 0.02 ||
      timestampVerdict.historicalPerformanceDecision !==
        canonicalVerdict.historicalPerformanceDecision,
    interpretation:
      events.every((event) => event.logIndex == null)
        ? "reloaded_persisted_events_lack_log_index_metadata"
        : "mixed",
  };
}

async function main() {
  const [passWallets, failWallets, safeWallets] = await Promise.all([
    sampleWallets("PASS", 5),
    sampleWallets("FAIL", 5),
    sampleMetricsSafeWallets(5),
  ]);
  const wallets = [...new Set([...passWallets, ...failWallets, ...safeWallets])];
  const results = [];
  for (const wallet of wallets) {
    results.push(await compareWallet(wallet));
  }

  console.log(
    JSON.stringify(
      {
        mode: "ledger_ordering_impact_audit",
        note:
          "Compares timestamp-only replay on reloaded persisted events vs canonical chain-order replay. Persisted rows currently lack log_index in most cases, so canonical replay may match timestamp replay until hydration repopulates metadata.",
        samples: {
          stageCPass: passWallets,
          stageCFail: failWallets,
          metricsSafe: safeWallets,
        },
        results,
        summary: {
          walletsCompared: results.filter((row) => !row.skipped).length,
          materialChanges: results.filter((row) => row.materialChange).length,
          policyAChanges: results.filter((row) => row.deltas?.policyAChanged)
            .length,
        },
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
