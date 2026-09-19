#!/usr/bin/env tsx
import "../tests/preload-env";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletHistoricalMetrics } from "@/lib/crossmarket/store/schema";
import { sortLedgerEventsCanonical } from "@/lib/walletLedger/eventOrder";
import { fetchActivityHistory, fetchTradeHistory } from "@/lib/walletLedger/fetchers";
import { GammaResolutionCache, buildMarketResolveHints } from "@/lib/walletLedger/gamma";
import { evaluateHistoricalPerformanceVerdict } from "@/lib/walletLedger/indexed/historicalPerformanceVerdict";
import { readPersistentGammaCache } from "@/lib/walletLedger/indexed/gammaCacheStore";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { countPersistedEventMetadataCoverage } from "@/lib/walletLedger/indexed/store/eventMetadataEnrichment";
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

const WALLET = "0x4f29e103339919c4baaea2a60195cf1c8bb27a7e";

async function main() {
  const persisted = sortLedgerEventsCanonical(await loadPersistedWalletEvents(WALLET));
  const [activity, trades] = await Promise.all([
    fetchActivityHistory(WALLET, { interPageDelayMs: 25 }),
    fetchTradeHistory(WALLET, { interPageDelayMs: 25 }),
  ]);
  const apiEvents = deduplicateLedgerEvents(
    normalizeActivityRows(activity.rows, WALLET),
    normalizeTradeRows(trades.rows, WALLET)
  );
  const combined = mergeApiAndChainEvents(apiEvents, persisted);
  const gammaCache = new GammaResolutionCache();
  gammaCache.seedMany(readPersistentGammaCache().entries());
  await gammaCache.prefetch(buildMarketResolveHints(combined));
  const { positions } = await buildPositionLifecycles(WALLET, combined, gammaCache);
  const metrics = computeWalletLedgerMetrics({
    positions,
    identity: {
      confidence: "high",
      resolutionMethod: "proxy_wallet_direct",
      positionsOnlyMismatch: false,
    },
    activityTruncated: false,
    tradesTruncated: false,
    rawEventCount: combined.length,
    deduplicatedEventCount: combined.length,
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
    mergeSplit: analyzeMergeSplitImpact(positions),
    hasHistoryEvents: combined.length > 0,
  });
  const policyAVerdict = evaluateHistoricalPerformanceVerdict({
    indexedDataValidity: metrics.credibilityMetricsValid,
    historyValidity: metrics.historyValidity,
    completedPositionCount: metrics.completedPositionCount,
    realizedRoi: metrics.portfolioRealizedRoi,
    profitablePositionRate: metrics.profitablePositionRate,
    metricVersion: WALLET_METRIC_VERSION,
  }).historicalPerformanceDecision;

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

  const coverage = await countPersistedEventMetadataCoverage(WALLET);
  const deltaCompleted =
    (metrics.completedPositionCount ?? 0) - (durable?.completedPositions ?? 0);
  const drift =
    durable?.completedPositions && durable.completedPositions > 0
      ? Math.abs(deltaCompleted) / durable.completedPositions
      : 0;

  console.log(
    JSON.stringify(
      {
        wallet: WALLET,
        durable: {
          completedPositions: durable?.completedPositions,
          realizedRoi: durable?.realizedRoi,
          profitablePositionRate: durable?.profitablePositionRate,
          policyAVerdict: evaluateHistoricalPerformanceVerdict({
            indexedDataValidity: durable?.credibilityMetricsValid,
            historyValidity: durable?.historyValidity,
            completedPositionCount: durable?.completedPositions,
            realizedRoi: durable?.realizedRoi,
            profitablePositionRate: durable?.profitablePositionRate,
            metricVersion: WALLET_METRIC_VERSION,
          }).historicalPerformanceDecision,
        },
        validation: {
          completedPositions: metrics.completedPositionCount,
          realizedRoi: metrics.portfolioRealizedRoi,
          profitablePositionRate: metrics.profitablePositionRate,
          policyAVerdict,
          lifecycleEpisodes: positions.length,
          combinedEvents: combined.length,
        },
        delta: {
          completedPositions: deltaCompleted,
          realizedRoi:
            (metrics.portfolioRealizedRoi ?? 0) - (durable?.realizedRoi ?? 0),
          profitablePositionRate:
            (metrics.profitablePositionRate ?? 0) -
            (durable?.profitablePositionRate ?? 0),
          completedDriftPct: drift,
        },
        pipelineValidationMatched:
          drift <= 0.05 &&
          policyAVerdict ===
            evaluateHistoricalPerformanceVerdict({
              indexedDataValidity: durable?.credibilityMetricsValid,
              historyValidity: durable?.historyValidity,
              completedPositionCount: durable?.completedPositions,
              realizedRoi: durable?.realizedRoi,
              profitablePositionRate: durable?.profitablePositionRate,
              metricVersion: WALLET_METRIC_VERSION,
            }).historicalPerformanceDecision,
        persistedMetadataCoverage: coverage,
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
