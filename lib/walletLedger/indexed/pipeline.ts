import {
  fetchActivityHistory,
  fetchTradeHistory,
} from "@/lib/walletLedger/fetchers";
import {
  buildMarketResolveHints,
  GammaResolutionCache,
} from "@/lib/walletLedger/gamma";
import { selectBestAvailableProvider } from "@/lib/walletLedger/indexed/providers/registry";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import {
  analyzeIndexedEventFunnel,
  formatFunnelReport,
  type IndexedEventFunnel,
} from "@/lib/walletLedger/indexed/funnel";
import {
  AuditStageTimer,
  EtherscanProgressReporter,
  auditLog,
  describeEtherscanQueryLabel,
  setAuditProgressEnabled,
  stopTrackedEtherscanProgress,
  trackEtherscanProgress,
} from "@/lib/walletLedger/indexed/auditProgress";
import {
  resolveAdaptiveFromBlock,
  verifyOldestTradeTxHashes,
  verifiedOldestBlockFromEvidence,
} from "@/lib/walletLedger/indexed/adaptiveStartBlock";
import {
  buildCredibilityResult,
  computeSourceBoundaryStats,
  effectiveExtendsBeforeApiBoundary,
  effectiveEventsBeforeApiBoundary,
  resolveSourceSpecificTruncationFlags,
  selectTruncationImmunityCoverage,
  type CredibilityResult,
} from "@/lib/walletLedger/indexed/indexedCredibility";
import {
  computeCheckpointResumePlan,
  QUERY_PLAN_VERSION,
  readEtherscanCheckpointForIdentity,
} from "@/lib/walletLedger/indexed/checkpoint";
import { authoritativeEventMergeKey } from "@/lib/walletLedger/canonicalChainIdentity";
import { buildChainCoordinateLogIndexLookup } from "@/lib/walletLedger/indexed/store/eventMetadataEnrichment";
import { backfillAuthoritativeLogIndexFromLookup } from "@/lib/walletLedger/indexed/store/logIndexTaxonomy";
import { assessUnresolvedChainOrder } from "@/lib/walletLedger/indexed/store/unresolvedChainOrder";
import {
  applyBlockTimestampsToEvents,
  assessCoverageConsistency,
  buildAuthoritativeEventMergeStats,
  buildAuthoritativeMergeSupplements,
  collectBlocksMissingTimestamps,
  countDuplicateDeltaEvents,
  mergeAuthoritativeIndexedEventsWithDiagnostics,
  mergeMonotonicCoverageFields,
  resolveIncrementalFromBlock,
} from "@/lib/walletLedger/indexed/authoritativeEvents";
import {
  buildEtherscanQueryPlan,
  formatWalletTopicEncoding,
  ORDER_FILLED_TOPIC_LAYOUT,
  type EtherscanQueryPlanReport,
} from "@/lib/walletLedger/indexed/queryPlan";
import { fetchIndexedConditionResolutions } from "@/lib/walletLedger/indexed/resolutionIndex";
import type {
  IndexedAuditWalletResult,
  IndexedFeasibilityEstimate,
  IndexedProviderEvaluation,
  IndexedProviderId,
  IndexedWalletCoverageReport,
  IndexedWalletDebugReport,
} from "@/lib/walletLedger/indexed/types";
import {
  fetchIndexedWalletHistory,
} from "@/lib/walletLedger/indexed/walletHistory";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { resolveBlockTimestamps } from "@/lib/walletLedger/indexed/blockTimestampCache";
import {
  mergeGammaCacheToDisk,
  readPersistentGammaCache,
} from "@/lib/walletLedger/indexed/gammaCacheStore";
import {
  computeWalletLedgerMetricsProfiled,
  explainHistoryCompleteness,
} from "@/lib/walletLedger/indexed/metricsProfile";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import {
  loadPersistedCoverageSnapshot,
  loadLastIndexedBlock,
  loadPersistedWalletEvents,
} from "@/lib/walletLedger/indexed/store/persistWalletHistory";
import { getLastPersistedEventLoadStats } from "@/lib/walletLedger/indexed/store/persistedEventLoader";
import {
  readWalletHistoryState,
  writeWalletHistoryState,
} from "@/lib/walletLedger/indexed/walletHistoryState";
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
import { buildWalletLogQueries } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import { appendAll, maxOf, minOf } from "@/lib/walletLedger/indexed/arrayUtils";
import { dedupeLogs } from "@/lib/walletLedger/onchain/rpc";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export function stopActiveEtherscanProgress(): void {
  stopTrackedEtherscanProgress();
}

export interface RunIndexedWalletAuditInput {
  label: string;
  wallet: string;
  transactionHash?: string;
  assetId?: string;
  providerId?: IndexedProviderId;
  providerEvaluations?: import("@/lib/walletLedger/indexed/types").IndexedProviderEvaluation[];
  fullHistory?: boolean;
  maxBlocksToScan?: number;
  interPageDelayMs?: number;
  debug?: boolean;
  resumeCheckpoint?: boolean;
  abortSignal?: AbortSignal;
  /** Pilot backfill: allow adaptive start earlier than incremental checkpoint. */
  allowEarlierThanIncremental?: boolean;
}

function buildIndexedCoverage(input: {
  apiEvents: WalletLedgerEvent[];
  indexedEvents: WalletLedgerEvent[];
  fromBlock: number;
  toBlock: number;
  fullHistory: boolean;
  errors: string[];
  oldestActivityTimestamp: number | null;
  oldestTradesTimestamp: number | null;
  apiOldestTimestamp: number | null;
  sourceBoundaries: ReturnType<typeof computeSourceBoundaryStats>;
  truncationImmunity: ReturnType<typeof resolveSourceSpecificTruncationFlags>;
  adaptiveFromBlockReason?: string;
  apiCompleted: number;
  indexedCompleted: number;
}): IndexedWalletCoverageReport {
  const apiTs = input.apiEvents.map((e) => e.timestamp).filter(Boolean);
  const indexedTs = input.indexedEvents.map((e) => e.timestamp).filter(Boolean);
  const indexedOldest = minOf(indexedTs);

  const eventsBeforeApiBoundary = Math.max(
    input.sourceBoundaries.eventsBeforeActivityBoundary,
    input.sourceBoundaries.eventsBeforeTradesBoundary
  );

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
    apiOldestTimestamp: input.apiOldestTimestamp,
    apiNewestTimestamp: maxOf(apiTs),
    oldestActivityTimestamp: input.oldestActivityTimestamp,
    oldestTradesTimestamp: input.oldestTradesTimestamp,
    indexedOldestTimestamp: indexedOldest,
    indexedNewestTimestamp: maxOf(indexedTs),
    apiEventCount: input.apiEvents.length,
    indexedEventCount: input.indexedEvents.length,
    eventsBeforeApiBoundary,
    eventsBeforeActivityBoundary:
      input.sourceBoundaries.eventsBeforeActivityBoundary,
    eventsBeforeTradesBoundary:
      input.sourceBoundaries.eventsBeforeTradesBoundary,
    activityTruncationImmune: input.truncationImmunity.activityTruncationImmune,
    tradesTruncationImmune: input.truncationImmunity.tradesTruncationImmune,
    additionalCompletedPositions: Math.max(
      0,
      input.indexedCompleted - input.apiCompleted
    ),
    scanFromBlock: input.fromBlock,
    scanToBlock: input.toBlock,
    adaptiveFromBlockReason: input.adaptiveFromBlockReason,
    indexedHistoryComplete,
    completenessNotes: notes,
  };
}

export async function runIndexedWalletAudit(
  input: RunIndexedWalletAuditInput
): Promise<IndexedAuditWalletResult> {
  const progressEnabled =
    input.debug === true ||
    input.fullHistory === true ||
    process.env.AUDIT_PROGRESS === "1";
  setAuditProgressEnabled(progressEnabled);
  const stages = new AuditStageTimer();

  const rpc = new PolygonRpcClient();
  const wallet = input.wallet.toLowerCase();

  stages.start("provider_select");
  const providerSelection = await selectBestAvailableProvider(
    input.providerId,
    { evaluations: input.providerEvaluations }
  );
  const provider = providerSelection.provider;
  const providerProbe = providerSelection.probe;
  stages.end(
    "provider_select",
    `provider=${provider.id} reused=${providerSelection.reusedEvaluation} probeAttempts=${providerSelection.probeAttempts}`
  );

  stages.start("identity_resolution_onchain");
  const identity = await discoverOnChainWalletIdentity({
    wallet,
    transactionHash: input.transactionHash,
    assetId: input.assetId,
    rpc,
  });
  stages.end("identity_resolution_onchain");

  stages.start("identity_resolution_history");
  const historyIdentity = await resolvePolymarketHistoryIdentity({
    wallet,
    transactionHash: input.transactionHash,
    assetId: input.assetId,
  });
  stages.end("identity_resolution_history");

  const historyWallet = historyIdentity.historyWallet ?? wallet;
  const persistedDbEvents = await loadPersistedWalletEvents(historyWallet);
  const persistedLoadStats = getLastPersistedEventLoadStats();
  if (persistedLoadStats) {
    auditLog(
      `[persisted-events] wallet=${historyWallet} rows=${persistedLoadStats.persistedEventRows} pages=${persistedLoadStats.persistedEventPages} pageSize=${persistedLoadStats.persistedEventPageSize} loadMs=${persistedLoadStats.persistedEventLoadMs} largestPageMs=${persistedLoadStats.largestPageMs} heapBeforeMb=${persistedLoadStats.heapBeforeMb} heapAfterMb=${persistedLoadStats.heapAfterMb}`
    );
  }
  const lastIndexedBlock = await loadLastIndexedBlock(historyWallet);
  const persistedCoverageEarly = await loadPersistedCoverageSnapshot(historyWallet);
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

  stages.start("data_api_history_fetch", `wallet=${historyWallet.slice(0, 10)}…`);
  const [activity, trades] = await Promise.all([
    fetchActivityHistory(historyWallet, { interPageDelayMs: 50 }),
    fetchTradeHistory(historyWallet, { interPageDelayMs: 50 }),
  ]);
  stages.end(
    "data_api_history_fetch",
    `activity=${activity.rows.length} trades=${trades.rows.length} activityPages=${activity.pagesFetched} tradePages=${trades.pagesFetched}`
  );

  stages.start("normalization");
  const apiActivityEvents = normalizeActivityRows(activity.rows, historyWallet);
  const apiTradeEvents = normalizeTradeRows(trades.rows, historyWallet);
  stages.end("normalization", `activity=${apiActivityEvents.length} trades=${apiTradeEvents.length}`);

  stages.start("deduplication");
  const apiEvents = deduplicateLedgerEvents(apiActivityEvents, apiTradeEvents);
  stages.end("deduplication", `events=${apiEvents.length}`);

  stages.start("chain_head_lookup");
  const window = await determineWalletBlockWindow({
    activityRows: activity.rows,
    tradeRows: trades.rows,
    extraTxHashes: input.transactionHash ? [input.transactionHash] : [],
    lookbackBlocks: 500_000,
    rpc,
  });

  const headBlock =
    window.endBlock ?? (await rpc.getBlockNumber()) ?? window.apiNewestBlock ?? 0;
  stages.end("chain_head_lookup", `headBlock=${headBlock}`);

  const priorHistoryState = readWalletHistoryState(historyWallet, provider.id);
  if (priorHistoryState) {
    auditLog(
      `[wallet-history-state] prior lastReconstructed=${priorHistoryState.lastReconstructedBlock} events=${priorHistoryState.eventCount} historyComplete=${priorHistoryState.historyComplete}`
    );
  }

  const fullHistory = input.fullHistory ?? false;
  const maxBlocks = input.maxBlocksToScan ?? (fullHistory ? headBlock : 100_000);

  const incrementalFromBlock = resolveIncrementalFromBlock({
    fullHistory,
    lastIndexedBlock,
    persistedEventCount: persistedDbEvents.length,
    headBlock,
    maxBlocksToScan: maxBlocks,
  });

  const verifiedTradeEvidence = await verifyOldestTradeTxHashes(trades.rows, 10);
  const verifiedOldestTradeBlock =
    verifiedOldestBlockFromEvidence(verifiedTradeEvidence);
  const adaptiveFrom = resolveAdaptiveFromBlock({
    wallet: historyWallet,
    incrementalFromBlock,
    fullHistory,
    verifiedOldestTradeBlock,
    allowEarlierThanIncremental: input.allowEarlierThanIncremental ?? false,
  });
  let fromBlock = adaptiveFrom.fromBlock;
  const toBlock = headBlock;
  if (persistedDbEvents.length > 0) {
    auditLog(
      `[authoritative-events] persistedDb=${persistedDbEvents.length} lastIndexedBlock=${lastIndexedBlock ?? "none"} incrementalFromBlock=${incrementalFromBlock} adaptiveFromBlock=${fromBlock} reason=${adaptiveFrom.reason}`
    );
  } else {
    auditLog(
      `[adaptive-from-block] fromBlock=${fromBlock} reason=${adaptiveFrom.reason} earliestRelevant=${adaptiveFrom.earliestRelevantBlock ?? "none"} source=${adaptiveFrom.contributingSource} verifiedTrade=${verifiedOldestTradeBlock ?? "none"} verifiedChain=${adaptiveFrom.verifiedRelevantChainEventBlock ?? "none"}`
    );
  }

  stages.start("query_plan_construction");
  const queryPlanPreview = buildEtherscanQueryPlan(
    historyWallet,
    fromBlock,
    toBlock,
    scanSubjects
  );
  stages.end(
    "query_plan_construction",
    `queries=${queryPlanPreview.walletLogQueries} subjects=${scanSubjects.length}`
  );

  stages.start("checkpoint_load");
  let checkpointHits = 0;
  if (provider.id === "etherscan_v2") {
    const previewQueries = buildWalletLogQueries(historyWallet, fromBlock, toBlock);
    for (let i = 0; i < previewQueries.length; i += 1) {
      const query = previewQueries[i]!;
      const identity = {
        providerId: provider.id,
        chainId: "137",
        wallet: historyWallet.toLowerCase(),
        contract: query.address.toLowerCase(),
        stableFromBlock: query.fromBlock,
        topics: query.topics ?? [],
      };
      const existing = readEtherscanCheckpointForIdentity(identity, {
        includeLogs: false,
      });
      if (existing) {
        checkpointHits += 1;
        const plan = computeCheckpointResumePlan(
          query.fromBlock,
          query.toBlock,
          existing.completedRanges
        );
        auditLog(
          `[audit-stage] checkpoint_found query=${describeEtherscanQueryLabel(query)} logs=${existing.logCount ?? existing.logs.length} reusedBlocks=${plan.reusedBlocks} newBlocks=${plan.newBlocksToFetch}`
        );
      }
    }
  }
  stages.end("checkpoint_load", `hits=${checkpointHits}/${queryPlanPreview.walletLogQueries}`);

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
  const parsedBySubject = new Map<
    string,
    import("@/lib/walletLedger/onchain/types").ParsedOnChainEvent[]
  >();
  const logsBySubject = new Map<
    string,
    import("@/lib/walletLedger/onchain/types").RpcLog[]
  >();
  const fetchedAddresses = new Set<string>();
  const etherscanProgress =
    provider.id === "etherscan_v2" && progressEnabled
      ? new EtherscanProgressReporter(queryPlanPreview.walletLogQueries)
      : null;
  if (etherscanProgress) {
    trackEtherscanProgress(etherscanProgress);
  }

  stages.start("indexed_etherscan_fetch", `fromBlock=${fromBlock} toBlock=${toBlock}`);
  try {
    for (const subject of scanSubjects) {
      if (fetchedAddresses.has(subject)) continue;
      fetchedAddresses.add(subject);
      const fetched = await fetchIndexedWalletHistory({
        provider,
        wallet: subject,
        fromBlock,
        toBlock,
        useCache: input.debug ? false : undefined,
        resumeCheckpoint: input.resumeCheckpoint,
        etherscanProgress: etherscanProgress ?? undefined,
        abortSignal: input.abortSignal,
        onProgress: (stats) => {
          aggregateStats = {
            ...aggregateStats,
            currentFromBlock: stats.currentFromBlock,
            currentToBlock: stats.currentToBlock,
            elapsedMs: stats.elapsedMs,
            logsReturned: stats.logsReturned,
          };
        },
      });
      appendAll(allLogs, fetched.logs);
      parsedBySubject.set(subject, fetched.parsed);
      logsBySubject.set(subject, fetched.logs);
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
  } finally {
    etherscanProgress?.stop();
    stopTrackedEtherscanProgress();
  }
  const rawLogCount = allLogs.length;
  const dedupedLogs = dedupeLogs(allLogs);
  allLogs.length = 0;
  appendAll(allLogs, dedupedLogs);
  auditLog(
    `[audit-stage] indexed_fetch complete rawLogs=${rawLogCount} dedupedLogs=${dedupedLogs.length}`
  );
  stages.end(
    "indexed_etherscan_fetch",
    `requests=${aggregateStats.requests} rawLogs=${rawLogCount} dedupedLogs=${dedupedLogs.length}`
  );

  stages.start("indexed_normalization");
  const allParsed: import("@/lib/walletLedger/onchain/types").ParsedOnChainEvent[] =
    [];
  for (const parsed of parsedBySubject.values()) {
    appendAll(allParsed, parsed);
  }
  stages.end("indexed_normalization", `parsed=${allParsed.length}`);

  stages.start("indexed_deduplication");
  const indexedEventKeys = new Set<string>();
  for (const parsed of allParsed) {
    if (parsed.type === "unparsed") continue;
    indexedEventKeys.add(
      `${parsed.event.transactionHash}:${parsed.event.logIndex}`
    );
  }
  stages.end(
    "indexed_deduplication",
    `uniqueLogKeys=${indexedEventKeys.size}`
  );

  stages.start("ledger_reconstruction_block_timestamps");
  const onChainResolution = new OnChainResolutionCache();
  onChainResolution.seedFromLogs(allLogs);

  const blockNumbers = new Set<number>();
  for (const item of allParsed) {
    if (item.type !== "unparsed") blockNumbers.add(item.event.blockNumber);
  }
  for (const persistedEvent of persistedDbEvents) {
    if (persistedEvent.blockNumber) {
      blockNumbers.add(persistedEvent.blockNumber);
    }
  }
  const { timestamps: blockTimestamps, stats: blockTimestampStats } =
    await resolveBlockTimestamps(blockNumbers, undefined, { logSeeds: allLogs });
  const persistedTimestampHydrations = applyBlockTimestampsToEvents(
    persistedDbEvents,
    blockTimestamps
  );
  if (persistedTimestampHydrations > 0) {
    auditLog(
      `[authoritative-events] persistedTimestampHydrations=${persistedTimestampHydrations} beforeMerge=true`
    );
  }
  stages.end(
    "ledger_reconstruction_block_timestamps",
    `blocks=${blockNumbers.size} hits=${blockTimestampStats.hits} misses=${blockTimestampStats.misses} diskLoaded=${blockTimestampStats.diskEntriesLoaded} logicalRpc=${blockTimestampStats.logicalRpcLookups} rpcAttempts=${blockTimestampStats.rpcAttempts}`
  );

  stages.start("ledger_reconstruction_events");
  const indexedEventMap = new Map<string, WalletLedgerEvent>();
  const funnelBySubject: Record<string, IndexedEventFunnel> = {};
  for (const subject of scanSubjects) {
    const subjectParsed = parsedBySubject.get(subject) ?? [];
    const subjectLogs = logsBySubject.get(subject) ?? [];
    const { events } = parsedEventsToLedgerEvents(
      subjectParsed,
      subject,
      blockTimestamps
    );
    funnelBySubject[subject] = analyzeIndexedEventFunnel({
      logs: subjectLogs,
      parsed: subjectParsed,
      wallet: subject,
      blockTimestamps,
      finalEvents: events,
    });
    for (const event of events) {
      const mergeKey = authoritativeEventMergeKey(event);
      indexedEventMap.set(mergeKey, {
        ...event,
        dedupeKey: mergeKey,
        source: event.source === "polygon" ? "polygon" : event.source,
      });
    }
  }
  const deltaIndexedEvents = [...indexedEventMap.values()];
  const duplicateDeltaEvents = countDuplicateDeltaEvents(
    persistedDbEvents,
    deltaIndexedEvents
  );
  const coverageAssessment = assessCoverageConsistency({
    persistedDbEventCount: persistedDbEvents.length,
    checkpointEventCount: deltaIndexedEvents.length,
    persistedCoverage: persistedCoverageEarly,
    fullHistory,
  });
  const mergeSupplements = buildAuthoritativeMergeSupplements({
    blockTimestamps,
    verifiedTradeEvidence,
  });
  let { events: authoritativeIndexedEvents, diagnostics: mergeDiagnostics } =
    mergeAuthoritativeIndexedEventsWithDiagnostics(
      persistedDbEvents,
      deltaIndexedEvents,
      { supplements: mergeSupplements }
    );
  const logIndexBackfill = backfillAuthoritativeLogIndexFromLookup(
    authoritativeIndexedEvents,
    buildChainCoordinateLogIndexLookup([
      ...deltaIndexedEvents,
      ...authoritativeIndexedEvents,
    ])
  );
  if (logIndexBackfill.backfilled > 0) {
    authoritativeIndexedEvents = logIndexBackfill.events;
    auditLog(
      `[authoritative-events] logIndexCoordinateBackfills=${logIndexBackfill.backfilled}`
    );
  }
  const blocksMissingTimestamps =
    collectBlocksMissingTimestamps(authoritativeIndexedEvents);
  if (blocksMissingTimestamps.size > 0) {
    const { timestamps: backfillTimestamps } = await resolveBlockTimestamps(
      blocksMissingTimestamps,
      undefined,
      { logSeeds: allLogs }
    );
    const backfilledTimestamps = applyBlockTimestampsToEvents(
      authoritativeIndexedEvents,
      backfillTimestamps
    );
    if (backfilledTimestamps > 0) {
      auditLog(
        `[authoritative-events] backfilledTimestamps=${backfilledTimestamps} blocks=${blocksMissingTimestamps.size}`
      );
    }
  }
  const authoritativeEventStats = buildAuthoritativeEventMergeStats({
    persistedDbEventCount: persistedDbEvents.length,
    deltaEventCount: deltaIndexedEvents.length,
    duplicateDeltaEvents,
    checkpointEventCount: deltaIndexedEvents.length,
    authoritativeEventCount: authoritativeIndexedEvents.length,
    usedPersistedDbBase: persistedDbEvents.length > 0,
    mergeDiagnostics,
  });
  auditLog(
    `[authoritative-events] persistedEvents=${persistedDbEvents.length} newDeltaEvents=${authoritativeEventStats.newDeltaEvents} duplicateDeltaEvents=${duplicateDeltaEvents} authoritativeEvents=${authoritativeIndexedEvents.length} duplicateEventsMerged=${mergeDiagnostics.duplicateEventsMerged} timestampUpgrades=${mergeDiagnostics.timestampUpgrades} timestampConflicts=${mergeDiagnostics.timestampConflicts} ledgerFieldConflicts=${mergeDiagnostics.ledgerFieldConflicts}`
  );
  if (authoritativeEventStats.checkpointSparse) {
    auditLog(
      `[authoritative-events] sparse checkpoint vs persistedDb=${persistedDbEvents.length} delta=${deltaIndexedEvents.length} authoritative=${authoritativeIndexedEvents.length}`
    );
  }
  stages.start("api_indexed_merge");
  const combinedEvents = mergeApiAndChainEvents(
    apiEvents,
    authoritativeIndexedEvents
  );
  stages.end(
    "api_indexed_merge",
    `api=${apiEvents.length} indexed=${authoritativeIndexedEvents.length} delta=${deltaIndexedEvents.length} combined=${combinedEvents.length}`
  );
  stages.end(
    "ledger_reconstruction_events",
    `indexed=${authoritativeIndexedEvents.length} combined=${combinedEvents.length}`
  );

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

  stages.start("gamma_resolution_work");
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
  const gammaDiskSeeded = gammaCache.seedMany(readPersistentGammaCache().entries());
  const gammaHints = buildMarketResolveHints(combinedEvents);
  const gammaPrefetch = await gammaCache.prefetch(gammaHints);
  auditLog(
    `[gamma-prefetch] hints=${gammaPrefetch.hintsTotal} pending=${gammaPrefetch.pending} diskSeeded=${gammaDiskSeeded} cacheHits=${gammaPrefetch.cacheHits} conditionLookups=${gammaPrefetch.conditionLookups} backfillLookups=${gammaPrefetch.backfillLookups} skippedBackfill=${gammaPrefetch.skippedBackfill} elapsedMs=${gammaPrefetch.elapsedMs}`
  );
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
  stages.end(
    "gamma_resolution_work",
    `onchainConditions=${conditionIds.length} hints=${gammaHints.length} gammaResolved=${gammaCache.countResolved()} prefetchMs=${gammaPrefetch.elapsedMs}`
  );

  stages.start("ledger_reconstruction_lifecycles");
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
  stages.end(
    "ledger_reconstruction_lifecycles",
    `apiPositions=${apiLifecycle.positions.length} indexedPositions=${indexedLifecycle.positions.length}`
  );
  mergeGammaCacheToDisk(new Map(gammaCache.exportEntries()));

  const apiCompleted = apiLifecycle.positions.filter((p) => p.completed).length;
  const indexedCompleted = indexedLifecycle.positions.filter(
    (p) => p.completed
  ).length;

  const sourceBoundaries = computeSourceBoundaryStats(
    authoritativeIndexedEvents,
    window.oldestActivityTimestamp,
    window.oldestTradesTimestamp
  );

  const persistedCoverageRaw = await loadPersistedCoverageSnapshot(historyWallet);
  const persistedCoverage = selectTruncationImmunityCoverage(
    persistedCoverageRaw,
    {
      wallet: historyWallet,
      chainId: "137",
      metricVersion: WALLET_METRIC_VERSION,
      provider: provider.id,
    }
  );

  const truncationImmunity = resolveSourceSpecificTruncationFlags({
    apiActivityTruncated: activity.truncated,
    apiTradesTruncated: trades.truncated,
    oldestActivityTimestamp: window.oldestActivityTimestamp,
    oldestTradesTimestamp: window.oldestTradesTimestamp,
    runSourceBoundaries: sourceBoundaries,
    persistedCoverage,
  });

  const coverage = buildIndexedCoverage({
    apiEvents,
    indexedEvents: authoritativeIndexedEvents,
    fromBlock,
    toBlock,
    fullHistory,
    errors: aggregateStats.errors,
    oldestActivityTimestamp: window.oldestActivityTimestamp,
    oldestTradesTimestamp: window.oldestTradesTimestamp,
    apiOldestTimestamp: window.apiOldestTimestamp,
    sourceBoundaries,
    truncationImmunity,
    adaptiveFromBlockReason: adaptiveFrom.reason,
    apiCompleted,
    indexedCompleted,
  });
  coverage.indexedOldestTimestamp = sourceBoundaries.indexedOldestTimestamp;
  coverage.indexedNewestTimestamp = maxOf(
    authoritativeIndexedEvents.map((event) => event.timestamp).filter(Boolean)
  );
  coverage.indexedEventCount = authoritativeIndexedEvents.length;

  const monotonicCoverage = mergeMonotonicCoverageFields(persistedCoverage, {
    extendsBeforeApiBoundary:
      sourceBoundaries.activityExtendsBeforeBoundary ||
      sourceBoundaries.tradesExtendsBeforeBoundary,
    eventsBeforeApiBoundary: Math.max(
      sourceBoundaries.eventsBeforeActivityBoundary,
      sourceBoundaries.eventsBeforeTradesBoundary
    ),
    indexedOldestTimestamp: sourceBoundaries.indexedOldestTimestamp,
    lastIndexedBlock: toBlock,
    lastReconstructedBlock: toBlock,
  });

  const extendsBeforeApiBoundary = effectiveExtendsBeforeApiBoundary({
    runExtendsBeforeApiBoundary: monotonicCoverage.extendsBeforeApiBoundary,
    runEventsBeforeApiBoundary: monotonicCoverage.eventsBeforeApiBoundary,
    persistedCoverage,
  });

  if (
    (truncationImmunity.activityTruncationImmune && activity.truncated) ||
    (truncationImmunity.tradesTruncationImmune && trades.truncated)
  ) {
    auditLog(
      `[indexed-truncation-immunity] activityTruncated=${activity.truncated} tradesTruncated=${trades.truncated} activityImmune=${truncationImmunity.activityTruncationImmune} tradesImmune=${truncationImmunity.tradesTruncationImmune} preActivity=${coverage.eventsBeforeActivityBoundary} preTrades=${coverage.eventsBeforeTradesBoundary}`
    );
  }

  const activityTruncatedAfter = truncationImmunity.activityTruncated;
  const tradesTruncatedAfter = truncationImmunity.tradesTruncated;

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
  const unresolvedChainOrder = assessUnresolvedChainOrder(
    authoritativeIndexedEvents
  );

  stages.start("metric_computation");
  const mergeSplitApi = analyzeMergeSplitImpact(apiLifecycle.positions);
  const apiMetrics =
    apiLifecycle.positions.length > 0
      ? computeWalletLedgerMetricsProfiled({
          positions: apiLifecycle.positions,
          identity: historyIdentity,
          activityTruncated: activity.truncated,
          tradesTruncated: trades.truncated,
          rawEventCount: apiEvents.length,
          deduplicatedEventCount: apiEvents.length,
          gammaCoverage,
          mergeSplit: mergeSplitApi,
          hasHistoryEvents: apiEvents.length > 0,
        }).metrics
      : null;

  const indexedMetricsResult = computeWalletLedgerMetricsProfiled({
    positions: indexedLifecycle.positions,
    identity: historyIdentity,
    activityTruncated: activityTruncatedAfter,
    tradesTruncated: tradesTruncatedAfter,
    rawEventCount: combinedEvents.length,
    deduplicatedEventCount: combinedEvents.length,
    gammaCoverage,
    mergeSplit,
    hasHistoryEvents: combinedEvents.length > 0,
    historicalBackfillRequired: coverageAssessment.historicalBackfillRequired,
    unresolvedChainOrderBlocksCredibility:
      unresolvedChainOrder.blocksCredibility,
    unresolvedChainEvents: unresolvedChainOrder.unresolvedChainEvents,
    unresolvedChainEventsInLifecycle:
      unresolvedChainOrder.unresolvedChainEventsInLifecycle,
    affectedPositionGroups: unresolvedChainOrder.affectedPositionGroups,
  });
  const indexedMetrics = indexedMetricsResult.metrics;
  const indexedCompleteness = explainHistoryCompleteness(indexedMetrics);
  const apiCredibility = apiMetrics ? buildCredibilityResult(apiMetrics) : null;
  const indexedCredibility = buildCredibilityResult(indexedMetrics);
  auditLog(
    `[history-completeness] complete=${indexedCredibility.historyComplete} validity=${indexedCredibility.historyValidity} credibility=${indexedCredibility.credibilityDecision} reasons=${indexedCredibility.reasons.join(",") || "none"}`
  );

  const reconciliation = reconcileApiAndChainTrades(
    activity.rows,
    trades.rows,
    authoritativeIndexedEvents
  );
  stages.end(
    "metric_computation",
    `indexedComputeMs=${indexedMetricsResult.profile.computeMetricsMs} reconcile=api${reconciliation.apiTradeCount}/chain${reconciliation.chainTradeCount}`
  );

  writeWalletHistoryState({
    wallet: historyWallet,
    providerId: provider.id,
    queryPlanVersion: QUERY_PLAN_VERSION,
    fromBlock,
    lastIndexedBlock: toBlock,
    lastReconstructedBlock: toBlock,
    eventCount: combinedEvents.length,
    positionCount: indexedLifecycle.positions.length,
    metricVersion: WALLET_METRIC_VERSION,
    calculatedAt: new Date().toISOString(),
    historyComplete: indexedMetrics.historyComplete,
    historyCompletenessReasons: indexedMetrics.historyCompletenessReasons,
  });

  const apiTxHashes = [
    ...new Set(apiEvents.map((e) => e.txHash).filter(Boolean) as string[]),
  ];
  const indexedTxHashes = [
    ...new Set(
      authoritativeIndexedEvents.map((e) => e.txHash).filter(Boolean) as string[]
    ),
  ];
  const indexedTxSet = new Set(indexedTxHashes);
  const overlappingTxHashes = apiTxHashes.filter((tx) => indexedTxSet.has(tx));

  const queryPlan = queryPlanPreview;

  const debugReport: IndexedWalletDebugReport | undefined = input.debug
    ? {
        queryPlan,
        scanSubjects,
        blockWindow: { fromBlock, toBlock, fullHistory },
        funnelBySubject,
        apiTxHashes,
        indexedTxHashes,
        overlappingTxHashes,
        orderFilledTopicLayout: ORDER_FILLED_TOPIC_LAYOUT,
        walletTopicEncoding: formatWalletTopicEncoding(historyWallet),
      }
    : undefined;

  if (input.debug && debugReport) {
    console.error("\n=== Phase 2D debug: query plan ===");
    console.error(debugReport.queryPlan.multiplication);
    console.error(
      `contracts=${queryPlan.contractsQueried.length} walletQueries=${queryPlan.walletLogQueries} roles=${queryPlan.walletRoleQueries.length}`
    );
    if (provider instanceof EtherscanV2LogProvider) {
      console.error(
        `adaptive: rangesQueried=${provider.rangesQueried} rangesSplit=${provider.rangesSplit} pagesFetched=${provider.pagesFetched} rps=${provider.rateLimiter.requestsPerSecond}`
      );
    }
    for (const subject of scanSubjects) {
      console.error(`\n=== Phase 2D debug: funnel ${subject} ===`);
      console.error(formatFunnelReport(funnelBySubject[subject]));
    }
    console.error(
      `\nAPI/indexed tx overlap: ${overlappingTxHashes.length}/${apiTxHashes.length}`
    );
  }

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
    credibilityMetricsValidBefore: apiCredibility?.credibilityMetricsValid ?? false,
    credibilityMetricsValidAfter: indexedCredibility.credibilityMetricsValid,
    apiCredibility,
    indexedCredibility,
    historyCompleteBefore: apiCredibility?.historyComplete ?? false,
    historyCompleteAfter: indexedCredibility.historyComplete,
    historyCompletenessBreakdown: indexedCompleteness,
    blockTimestampStats,
    gammaPrefetchStats: gammaPrefetch,
    extendsBeforeApiBoundary,
    eventsBeforeApiBoundaryEffective: effectiveEventsBeforeApiBoundary({
      runEventsBeforeApiBoundary: monotonicCoverage.eventsBeforeApiBoundary,
      persistedCoverage,
    }),
    sourceTruncationImmunity: truncationImmunity,
    verifiedTradeTxEvidence: verifiedTradeEvidence,
    adaptiveFromBlock: adaptiveFrom,
    indexedEvents: deltaIndexedEvents,
    authoritativeIndexedEvents,
    authoritativeEventStats,
    historicalBackfillRequired: coverageAssessment.historicalBackfillRequired,
    indexedLifecyclePositions: indexedLifecycle.positions,
    apiEvents,
    gammaCacheEntries: gammaCache.exportEntries(),
    throughBlock: toBlock,
    scanFromBlock: fromBlock,
    debugReport,
    stageTimingsMs: stages.snapshot(),
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
