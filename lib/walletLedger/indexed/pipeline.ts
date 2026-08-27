import {
  fetchActivityHistory,
  fetchTradeHistory,
} from "@/lib/walletLedger/fetchers";
import {
  buildMarketResolveHints,
  GammaResolutionCache,
} from "@/lib/walletLedger/gamma";
import { selectBestAvailableProvider } from "@/lib/walletLedger/indexed/providers/registry";
import { fetchIndexedConditionResolutions } from "@/lib/walletLedger/indexed/resolutionIndex";
import type {
  IndexedAuditWalletResult,
  IndexedFeasibilityEstimate,
  IndexedProviderEvaluation,
  IndexedProviderId,
  IndexedWalletCoverageReport,
} from "@/lib/walletLedger/indexed/types";
import {
  defaultWalletHistoryFromBlock,
  fetchIndexedWalletHistory,
} from "@/lib/walletLedger/indexed/walletHistory";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import {
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
import { resolvePolymarketHistoryIdentity } from "@/lib/walletLedger/identity";
import { discoverOnChainWalletIdentity } from "@/lib/walletLedger/onchain/identity";
import {
  mergeApiAndChainEvents,
  parsedEventsToLedgerEvents,
} from "@/lib/walletLedger/onchain/normalize";
import { reconcileApiAndChainTrades } from "@/lib/walletLedger/onchain/reconcile";
import { OnChainResolutionCache } from "@/lib/walletLedger/onchain/resolution";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import { determineWalletBlockWindow } from "@/lib/walletLedger/onchain/startBlock";
import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export interface RunIndexedWalletAuditInput {
  label: string;
  wallet: string;
  transactionHash?: string;
  assetId?: string;
  providerId?: IndexedProviderId;
  fullHistory?: boolean;
  maxBlocksToScan?: number;
  interPageDelayMs?: number;
}

function buildIndexedCoverage(input: {
  apiEvents: WalletLedgerEvent[];
  indexedEvents: WalletLedgerEvent[];
  fromBlock: number;
  toBlock: number;
  fullHistory: boolean;
  errors: string[];
  apiOldestTimestamp: number | null;
  apiCompleted: number;
  indexedCompleted: number;
}): IndexedWalletCoverageReport {
  const apiTs = input.apiEvents.map((e) => e.timestamp).filter(Boolean);
  const indexedTs = input.indexedEvents.map((e) => e.timestamp).filter(Boolean);
  const apiOldest = apiTs.length ? Math.min(...apiTs) : input.apiOldestTimestamp;
  const indexedOldest = indexedTs.length ? Math.min(...indexedTs) : null;

  const eventsBeforeApiBoundary =
    apiOldest != null && indexedOldest != null && indexedOldest < apiOldest
      ? input.indexedEvents.filter((e) => e.timestamp < apiOldest).length
      : 0;

  const notes: string[] = [];
  if (input.errors.length > 0) {
    notes.push(`fetch_errors=${input.errors.length}`);
  }
  if (!input.fullHistory) {
    notes.push("bounded_scan_not_full_exchange_history");
  }
  if (eventsBeforeApiBoundary > 0) {
    notes.push(`pre_api_events=${eventsBeforeApiBoundary}`);
  } else {
    notes.push("no_events_before_api_boundary_in_scan_window");
  }

  const indexedHistoryComplete =
    input.fullHistory &&
    input.fromBlock <= POLYMARKET_EXCHANGE_INITIAL_BLOCK &&
    input.errors.length === 0 &&
    eventsBeforeApiBoundary > 0;

  if (!indexedHistoryComplete) {
    notes.push("indexed_history_complete_not_proven");
  }

  return {
    apiOldestTimestamp: apiOldest,
    apiNewestTimestamp: apiTs.length ? Math.max(...apiTs) : null,
    indexedOldestTimestamp: indexedOldest,
    indexedNewestTimestamp: indexedTs.length ? Math.max(...indexedTs) : null,
    apiEventCount: input.apiEvents.length,
    indexedEventCount: input.indexedEvents.length,
    eventsBeforeApiBoundary,
    additionalCompletedPositions: Math.max(
      0,
      input.indexedCompleted - input.apiCompleted
    ),
    scanFromBlock: input.fromBlock,
    scanToBlock: input.toBlock,
    indexedHistoryComplete,
    completenessNotes: notes,
  };
}

export async function runIndexedWalletAudit(
  input: RunIndexedWalletAuditInput
): Promise<IndexedAuditWalletResult> {
  const rpc = new PolygonRpcClient();
  const wallet = input.wallet.toLowerCase();
  const provider = await selectBestAvailableProvider(input.providerId);
  const providerProbe = await provider.probe();

  const identity = await discoverOnChainWalletIdentity({
    wallet,
    transactionHash: input.transactionHash,
    assetId: input.assetId,
    rpc,
  });

  const historyIdentity = await resolvePolymarketHistoryIdentity({
    wallet,
    transactionHash: input.transactionHash,
    assetId: input.assetId,
  });

  const historyWallet = historyIdentity.historyWallet ?? wallet;
  const scanSubjects = [
    ...new Set(
      [
        wallet,
        historyWallet,
        ...identity.canonicalHistorySubjects,
        ...identity.relatedAddresses,
      ]
        .map((w) => w?.toLowerCase())
        .filter((w): w is string => Boolean(w))
    ),
  ];

  const [activity, trades] = await Promise.all([
    fetchActivityHistory(historyWallet, { interPageDelayMs: 50 }),
    fetchTradeHistory(historyWallet, { interPageDelayMs: 50 }),
  ]);

  const apiActivityEvents = normalizeActivityRows(activity.rows, historyWallet);
  const apiTradeEvents = normalizeTradeRows(trades.rows, historyWallet);
  const apiEvents = deduplicateLedgerEvents(apiActivityEvents, apiTradeEvents);

  const window = await determineWalletBlockWindow({
    activityRows: activity.rows,
    tradeRows: trades.rows,
    extraTxHashes: input.transactionHash ? [input.transactionHash] : [],
    lookbackBlocks: 500_000,
    rpc,
  });

  const headBlock =
    window.endBlock ?? (await rpc.getBlockNumber()) ?? window.apiNewestBlock ?? 0;
  const fullHistory = input.fullHistory ?? false;
  const maxBlocks = input.maxBlocksToScan ?? (fullHistory ? headBlock : 100_000);

  let fromBlock = defaultWalletHistoryFromBlock(
    window.apiOldestBlock,
    headBlock,
    fullHistory
  );
  let toBlock = headBlock;

  if (!fullHistory && window.apiOldestBlock != null) {
    fromBlock = Math.max(
      POLYMARKET_EXCHANGE_INITIAL_BLOCK,
      window.apiOldestBlock - maxBlocks
    );
    toBlock = window.apiOldestBlock;
  }

  let aggregateStats = {
    requests: 0,
    pages: 0,
    logsReturned: 0,
    blockWindows: 0,
    elapsedMs: 0,
    currentFromBlock: fromBlock,
    currentToBlock: toBlock,
    rateLimitHits: 0,
    errors: [] as string[],
    uniqueTransactions: 0,
  };

  const allLogs: import("@/lib/walletLedger/onchain/types").RpcLog[] = [];
  const allParsed: import("@/lib/walletLedger/onchain/types").ParsedOnChainEvent[] =
    [];

  for (const subject of scanSubjects) {
    const fetched = await fetchIndexedWalletHistory({
      provider,
      wallet: subject,
      fromBlock,
      toBlock,
      interPageDelayMs: input.interPageDelayMs ?? 200,
      onProgress: (stats) => {
        aggregateStats = { ...aggregateStats, ...stats };
      },
    });
    allLogs.push(...fetched.logs);
    allParsed.push(...fetched.parsed);
    aggregateStats = {
      ...aggregateStats,
      requests: aggregateStats.requests + fetched.stats.requests,
      pages: aggregateStats.pages + fetched.stats.pages,
      logsReturned: allLogs.length,
      blockWindows: aggregateStats.blockWindows + fetched.stats.blockWindows,
      elapsedMs: Math.max(aggregateStats.elapsedMs, fetched.stats.elapsedMs),
      rateLimitHits: aggregateStats.rateLimitHits + fetched.stats.rateLimitHits,
      errors: [...new Set([...aggregateStats.errors, ...fetched.stats.errors])],
      uniqueTransactions:
        aggregateStats.uniqueTransactions + fetched.stats.uniqueTransactions,
    };
  }

  const onChainResolution = new OnChainResolutionCache();
  onChainResolution.seedFromLogs(allLogs);

  const blockNumbers = new Set<number>();
  for (const item of allParsed) {
    if (item.type !== "unparsed") blockNumbers.add(item.event.blockNumber);
  }
  const blockTimestamps = new Map<number, number>();
  for (const block of blockNumbers) {
    const ts = await rpc.getBlockTimestamp(block);
    if (ts) blockTimestamps.set(block, ts);
  }

  const indexedEventMap = new Map<string, WalletLedgerEvent>();
  for (const subject of scanSubjects) {
    const { events } = parsedEventsToLedgerEvents(
      allParsed,
      subject,
      blockTimestamps
    );
    for (const event of events) {
      indexedEventMap.set(event.dedupeKey, {
        ...event,
        source: event.source === "polygon" ? "polygon" : event.source,
      });
    }
  }
  const indexedEvents = [...indexedEventMap.values()];
  const combinedEvents = mergeApiAndChainEvents(apiEvents, indexedEvents);

  const conditionIds = [
    ...new Set(
      allParsed
        .filter((p) => p.type === "condition_resolution")
        .map((p) =>
          p.type === "condition_resolution" ? p.event.conditionId : ""
        )
        .filter(Boolean)
    ),
  ];

  let resolutionFetch: Awaited<
    ReturnType<typeof fetchIndexedConditionResolutions>
  > | null = null;

  if (provider.id === "etherscan_v2" && conditionIds.length > 0) {
    resolutionFetch = await fetchIndexedConditionResolutions({
      provider,
      conditionIds: conditionIds.slice(0, 50),
      fromBlock: fromBlock,
      toBlock: headBlock,
    });
    onChainResolution.seedFromLogs(resolutionFetch.logs);
  } else {
    onChainResolution.seedFromLogs(allLogs);
  }

  const gammaCache = new GammaResolutionCache();
  await gammaCache.prefetch(buildMarketResolveHints(combinedEvents));
  for (const entry of onChainResolution.entries()) {
    const gamma = gammaCache.get(entry.conditionId);
    const resolved =
      entry.resolution.resolutionFinal
        ? entry.resolution
        : gamma?.resolutionFinal
          ? gamma
          : entry.resolution;
    if (resolved) gammaCache.seed(entry.conditionId, resolved);
  }

  const apiLifecycle = await buildPositionLifecycles(
    historyWallet,
    apiEvents,
    gammaCache
  );
  const indexedLifecycle = await buildPositionLifecycles(
    historyWallet,
    combinedEvents,
    gammaCache
  );

  const apiCompleted = apiLifecycle.positions.filter((p) => p.completed).length;
  const indexedCompleted = indexedLifecycle.positions.filter(
    (p) => p.completed
  ).length;

  const coverage = buildIndexedCoverage({
    apiEvents,
    indexedEvents,
    fromBlock,
    toBlock,
    fullHistory,
    errors: aggregateStats.errors,
    apiOldestTimestamp: window.apiOldestTimestamp,
    apiCompleted,
    indexedCompleted,
  });

  const extendsBeforeApiBoundary = coverage.eventsBeforeApiBoundary > 0;

  const activityTruncatedAfter = extendsBeforeApiBoundary
    ? false
    : activity.truncated;
  const tradesTruncatedAfter = extendsBeforeApiBoundary
    ? false
    : trades.truncated;

  const distinctMarkets = new Set(
    indexedLifecycle.positions.map((p) => p.conditionId).filter(Boolean)
  ).size;
  const gammaResolved = gammaCache.countResolved();
  const onchainFinal = onChainResolution.countFinal();
  const gammaCoverage = {
    distinctMarkets,
    marketsFoundBefore: gammaCache.countMarketFound(),
    marketsFoundAfter: gammaCache.countMarketFound(),
    resolvedBefore: gammaResolved,
    resolvedAfter: gammaResolved + onchainFinal,
    coverageBeforePct:
      distinctMarkets > 0 ? gammaResolved / distinctMarkets : 1,
    coverageAfterPct:
      distinctMarkets > 0
        ? (gammaResolved + onchainFinal) / distinctMarkets
        : 1,
    marketFoundCoverageAfterPct:
      distinctMarkets > 0
        ? gammaCache.countMarketFound() / distinctMarkets
        : 1,
  };

  const mergeSplit = analyzeMergeSplitImpact(indexedLifecycle.positions);

  const apiMetrics =
    apiLifecycle.positions.length > 0
      ? computeWalletLedgerMetrics({
          positions: apiLifecycle.positions,
          identity: historyIdentity,
          activityTruncated: activity.truncated,
          tradesTruncated: trades.truncated,
          rawEventCount: apiEvents.length,
          deduplicatedEventCount: apiEvents.length,
          gammaCoverage,
          mergeSplit: analyzeMergeSplitImpact(apiLifecycle.positions),
          hasHistoryEvents: apiEvents.length > 0,
        })
      : null;

  const indexedMetrics = computeWalletLedgerMetrics({
    positions: indexedLifecycle.positions,
    identity: historyIdentity,
    activityTruncated: activityTruncatedAfter,
    tradesTruncated: tradesTruncatedAfter,
    rawEventCount: combinedEvents.length,
    deduplicatedEventCount: combinedEvents.length,
    gammaCoverage,
    mergeSplit,
    hasHistoryEvents: combinedEvents.length > 0,
  });

  const reconciliation = reconcileApiAndChainTrades(
    activity.rows,
    trades.rows,
    indexedEvents
  );

  return {
    label: input.label,
    wallet,
    providerId: provider.id,
    providerProbe,
    identity,
    fetchStats: aggregateStats,
    resolutionFetchStats: resolutionFetch?.stats ?? null,
    coverage,
    reconciliation,
    apiLedgerMetrics: apiMetrics,
    indexedLedgerMetrics: indexedMetrics,
    apiOnlyPositions: apiLifecycle.positions.length,
    indexedPositions: indexedLifecycle.positions.length,
    apiCompletedPositions: apiCompleted,
    indexedCompletedPositions: indexedCompleted,
    credibilityMetricsValidBefore: apiMetrics?.credibilityMetricsValid ?? false,
    credibilityMetricsValidAfter: indexedMetrics.credibilityMetricsValid,
    historyCompleteBefore: apiMetrics?.historyComplete ?? false,
    historyCompleteAfter: indexedMetrics.historyComplete,
    extendsBeforeApiBoundary,
  };
}

export function estimateIndexedFeasibility(input: {
  wallets: number;
  avgEventsPerWallet?: number;
  providerId?: IndexedProviderId;
}): IndexedFeasibilityEstimate {
  const events = input.avgEventsPerWallet ?? 5_000;
  const provider = input.providerId ?? "etherscan_v2";

  if (provider === "etherscan_v2") {
    const blockWindowsPerWallet = Math.ceil(
      (35_000_000 - POLYMARKET_EXCHANGE_INITIAL_BLOCK) / 5_000
    );
    const queriesPerWallet = blockWindowsPerWallet * 7;
    const pagesPerWallet = Math.ceil(events / 1_000) * 7;
    const requests = input.wallets * (queriesPerWallet + pagesPerWallet);
    return {
      wallets: input.wallets,
      estimatedRequests: requests,
      estimatedDurationMinutes: (requests * 0.25) / 60,
      estimatedMonthlyCostUsd: input.wallets > 700 ? 49 : 0,
      notes: [
        "etherscan_free_tier_5_rps_100k_calls_per_day",
        "true_indexed_logs_avoid_empty_block_scans",
        "resolution_queries_are_per_conditionId_not_per_wallet",
      ],
    };
  }

  const rpcCallsPerWallet = 1_200;
  const requests = input.wallets * rpcCallsPerWallet;
  return {
    wallets: input.wallets,
    estimatedRequests: requests,
    estimatedDurationMinutes: (requests * 0.15) / 60,
    estimatedMonthlyCostUsd: null,
    notes: [
      "full_history_rpc_scales_with_block_range_not_event_count",
      "phase2c_observed_900_1400_calls_per_100k_block_window",
    ],
  };
}

export { evaluateIndexedProviders } from "@/lib/walletLedger/indexed/providers/registry";
export type { IndexedProviderEvaluation };
