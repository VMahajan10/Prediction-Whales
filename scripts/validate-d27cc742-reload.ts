#!/usr/bin/env tsx
/**
 * Validate d27cc742 reload paths against durable metrics — read-only except API fetch.
 */
import "../tests/preload-env";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletHistoricalMetrics } from "@/lib/crossmarket/store/schema";
import { sortLedgerEventsCanonical } from "@/lib/walletLedger/eventOrder";
import {
  fetchActivityHistory,
  fetchTradeHistory,
} from "@/lib/walletLedger/fetchers";
import { GammaResolutionCache, buildMarketResolveHints } from "@/lib/walletLedger/gamma";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { readPersistentGammaCache } from "@/lib/walletLedger/indexed/gammaCacheStore";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { countPersistedEventMetadataCoverage } from "@/lib/walletLedger/indexed/store/eventMetadataEnrichment";
import { loadPersistedLifecycleRows } from "@/lib/walletLedger/indexed/store/incrementalLifecycles";
import { loadPersistedWalletEvents } from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import {
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
import { mergeApiAndChainEvents } from "@/lib/walletLedger/onchain/normalize";

const WALLET = "0xd27cc742d023d06ef633a4c880cf1ff1836ec081";

function closeEnough(a: number | null | undefined, b: number | null | undefined, tol: number) {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) <= tol;
}

async function rebuild(
  wallet: string,
  events: Awaited<ReturnType<typeof loadPersistedWalletEvents>>,
  activityTruncated: boolean,
  tradesTruncated: boolean
) {
  const gammaCache = new GammaResolutionCache();
  gammaCache.seedMany(readPersistentGammaCache().entries());
  await gammaCache.prefetch(buildMarketResolveHints(events));
  const { positions } = await buildPositionLifecycles(wallet, events, gammaCache);
  const mergeSplit = analyzeMergeSplitImpact(positions);
  const metrics = computeWalletLedgerMetrics({
    positions,
    identity: {
      confidence: "high",
      resolutionMethod: "proxy_wallet_direct",
      positionsOnlyMismatch: false,
    },
    activityTruncated,
    tradesTruncated,
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
  return { positions, metrics, policyAVerdict: verdict.historicalPerformanceDecision };
}

async function main() {
  const coverage = await countPersistedEventMetadataCoverage(WALLET);
  const persisted = sortLedgerEventsCanonical(await loadPersistedWalletEvents(WALLET));
  const lifecycles = await loadPersistedLifecycleRows(WALLET);

  const db = getDb();
  const [durable] = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(
      and(
        eq(walletHistoricalMetrics.walletAddress, WALLET.toLowerCase()),
        eq(walletHistoricalMetrics.metricVersion, WALLET_METRIC_VERSION)
      )
    )
    .limit(1);

  const reasons = durable?.historyIncompleteReasons ?? [];
  const activityTruncated = reasons.includes("activity_truncated");
  const tradesTruncated = reasons.includes("trades_truncated");

  const authoritativeOnly = await rebuild(
    WALLET,
    persisted,
    activityTruncated,
    tradesTruncated
  );

  const [activity, trades] = await Promise.all([
    fetchActivityHistory(WALLET, { interPageDelayMs: 25 }),
    fetchTradeHistory(WALLET, { interPageDelayMs: 25 }),
  ]);
  const apiEvents = deduplicateLedgerEvents(
    normalizeActivityRows(activity.rows, WALLET),
    normalizeTradeRows(trades.rows, WALLET)
  );
  const combined = mergeApiAndChainEvents(apiEvents, persisted);
  const pipelineAligned = await rebuild(
    WALLET,
    combined,
    activityTruncated && !reasons.includes("gamma_resolution_incomplete"),
    tradesTruncated
  );
  const pipelineAlignedImmune = await rebuild(WALLET, combined, false, false);

  const authoritativeMatches =
    authoritativeOnly.metrics.completedPositionCount === durable?.completedPositions &&
    closeEnough(
      authoritativeOnly.metrics.portfolioRealizedRoi,
      durable?.realizedRoi,
      0.002
    );

  const pipelineMatches =
    pipelineAlignedImmune.metrics.completedPositionCount === durable?.completedPositions &&
    closeEnough(
      pipelineAlignedImmune.metrics.portfolioRealizedRoi,
      durable?.realizedRoi,
      0.002
    ) &&
    closeEnough(
      pipelineAlignedImmune.metrics.profitablePositionRate,
      durable?.profitablePositionRate,
      0.01
    ) &&
    pipelineAlignedImmune.policyAVerdict === "PASS";

  console.log(
    JSON.stringify(
      {
        mode: "validate_d27cc742_reload",
        wallet: WALLET,
        persistedCoverage: coverage,
        durable: {
          completedPositions: durable?.completedPositions,
          realizedRoi: durable?.realizedRoi,
          profitablePositionRate: durable?.profitablePositionRate,
          lifecycleEpisodes: lifecycles.length,
        },
        authoritativeOnlyReload: {
          events: persisted.length,
          completedPositions: authoritativeOnly.metrics.completedPositionCount,
          realizedRoi: authoritativeOnly.metrics.portfolioRealizedRoi,
          profitablePositionRate: authoritativeOnly.metrics.profitablePositionRate,
          lifecycleEpisodes: authoritativeOnly.positions.length,
          policyAVerdict: authoritativeOnly.policyAVerdict,
          matchesDurable: authoritativeMatches,
          note:
            "Authoritative persisted events alone omit API-only ledger rows used during audit metrics.",
        },
        pipelineAlignedReload: {
          events: combined.length,
          apiEvents: apiEvents.length,
          persistedEvents: persisted.length,
          completedPositions: pipelineAlignedImmune.metrics.completedPositionCount,
          realizedRoi: pipelineAlignedImmune.metrics.portfolioRealizedRoi,
          profitablePositionRate: pipelineAlignedImmune.metrics.profitablePositionRate,
          lifecycleEpisodes: pipelineAlignedImmune.positions.length,
          policyAVerdict: pipelineAlignedImmune.policyAVerdict,
          matchesDurable: pipelineMatches,
          truncationFlagsUsed: { activityTruncated: false, tradesTruncated: false },
        },
        recommendation: pipelineMatches ? "READY_FOR_SMALL_BATCH" : "FIX_REQUIRED",
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
