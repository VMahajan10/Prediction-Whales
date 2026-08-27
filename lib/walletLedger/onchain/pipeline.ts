import {
  fetchActivityHistory,
  fetchTradeHistory,
} from "@/lib/walletLedger/fetchers";
import {
  buildMarketResolveHints,
  GammaResolutionCache,
} from "@/lib/walletLedger/gamma";
import { buildPositionLifecycles } from "@/lib/walletLedger/ledger";
import { analyzeMergeSplitImpact } from "@/lib/walletLedger/mergeSplitAnalysis";
import { computeWalletLedgerMetrics } from "@/lib/walletLedger/metrics";
import {
  deduplicateLedgerEvents,
  normalizeActivityRows,
  normalizeTradeRows,
} from "@/lib/walletLedger/normalize";
import { resolvePolymarketHistoryIdentity } from "@/lib/walletLedger/identity";
import { assessWalletLedgerValidity } from "@/lib/walletLedger/validity";
import { discoverOnChainWalletIdentity } from "@/lib/walletLedger/onchain/identity";
import {
  fetchReceiptLogs,
  fetchWalletOnChainLogs,
} from "@/lib/walletLedger/onchain/fetcher";
import {
  mergeApiAndChainEvents,
  parsedEventsToLedgerEvents,
} from "@/lib/walletLedger/onchain/normalize";
import { decodeLog } from "@/lib/walletLedger/onchain/decode";
import { reconcileApiAndChainTrades } from "@/lib/walletLedger/onchain/reconcile";
import { OnChainResolutionCache } from "@/lib/walletLedger/onchain/resolution";
import { PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import { dedupeLogs } from "@/lib/walletLedger/onchain/rpc";
import { determineWalletBlockWindow } from "@/lib/walletLedger/onchain/startBlock";
import type {
  FeasibilityEstimate,
  OnChainAuditWalletResult,
  OnChainCoverageReport,
} from "@/lib/walletLedger/onchain/types";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export interface RunOnChainWalletAuditInput {
  label: string;
  wallet: string;
  transactionHash?: string;
  assetId?: string;
  lookbackBlocks?: number;
  maxBlocksToScan?: number;
  interBatchDelayMs?: number;
}

const DEFAULT_MAX_BLOCKS_TO_SCAN = Number(
  process.env.ONCHAIN_MAX_BLOCKS_TO_SCAN ?? "100000"
);

function buildCoverageReport(input: {
  window: Awaited<ReturnType<typeof determineWalletBlockWindow>>;
  apiEvents: WalletLedgerEvent[];
  chainEvents: WalletLedgerEvent[];
  scanStart: number;
  scanEnd: number;
  onChainHistoryComplete: boolean;
}): OnChainCoverageReport {
  const apiTs = input.apiEvents.map((e) => e.timestamp).filter(Boolean);
  const chainTs = input.chainEvents.map((e) => e.timestamp).filter(Boolean);
  const apiOldest = apiTs.length ? Math.min(...apiTs) : input.window.apiOldestTimestamp;
  const apiNewest = apiTs.length ? Math.max(...apiTs) : input.window.apiNewestTimestamp;
  const chainOldest = chainTs.length ? Math.min(...chainTs) : null;
  const chainNewest = chainTs.length ? Math.max(...chainTs) : null;

  const additionalHistorical =
    chainOldest != null && apiOldest != null && chainOldest < apiOldest
      ? input.chainEvents.filter((e) => e.timestamp < apiOldest).length
      : 0;

  return {
    apiOldestTimestamp: apiOldest,
    apiNewestTimestamp: apiNewest,
    apiOldestBlock: input.window.apiOldestBlock,
    apiNewestBlock: input.window.apiNewestBlock,
    chainOldestTimestamp: chainOldest,
    chainNewestTimestamp: chainNewest,
    chainOldestBlock: input.chainEvents.length
      ? Math.min(...input.chainEvents.map((e) => e.blockNumber ?? Number.MAX_SAFE_INTEGER))
      : null,
    chainNewestBlock: input.chainEvents.length
      ? Math.max(...input.chainEvents.map((e) => e.blockNumber ?? 0))
      : null,
    apiEventCount: input.apiEvents.length,
    chainEventCount: input.chainEvents.length,
    additionalHistoricalEvents: additionalHistorical,
    scanStartBlock: input.scanStart,
    scanEndBlock: input.scanEnd,
    onChainHistoryComplete: input.onChainHistoryComplete,
    completenessNotes: input.window.completenessNotes,
  };
}

export async function runOnChainWalletAudit(
  input: RunOnChainWalletAuditInput
): Promise<OnChainAuditWalletResult> {
  const rpc = new PolygonRpcClient();
  const wallet = input.wallet.toLowerCase();
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
    lookbackBlocks: input.lookbackBlocks ?? 500_000,
    rpc,
  });

  const receiptLogs = await fetchReceiptLogs(rpc, window.apiTxHashes);
  const receiptParsed = receiptLogs.map((log) => decodeLog(log));

  const maxScan = input.maxBlocksToScan ?? DEFAULT_MAX_BLOCKS_TO_SCAN;
  const preApiEnd = window.apiOldestBlock ?? window.endBlock;
  const preApiStart = Math.max(window.startBlock, preApiEnd - maxScan);
  const scanStart = preApiStart;
  const scanEnd = Math.min(preApiEnd, preApiStart + maxScan);

  let fetchStats = {
    blocksScanned: 0,
    rpcCalls: rpc.rpcCalls,
    logsReturned: receiptLogs.length,
    uniqueTransactions: window.apiTxHashes.length,
    elapsedMs: 0,
    currentFromBlock: scanStart,
    currentToBlock: scanEnd,
    rateLimitHits: rpc.rateLimitHits,
    retries: rpc.retries,
    errors: rpc.errors,
  };

  let scanLogs = receiptLogs;
  let scanParsed = receiptParsed;

  const scannedSubjects: string[] = [];

  for (const subjectWallet of scanSubjects) {
    if (scanEnd <= scanStart) break;
    const scanned = await fetchWalletOnChainLogs({
      wallet: subjectWallet,
      fromBlock: scanStart,
      toBlock: Math.min(scanEnd, scanStart + maxScan),
      interBatchDelayMs: input.interBatchDelayMs ?? 75,
      rpc,
      onProgress: (progress) => {
        fetchStats = { ...fetchStats, ...progress, rpcCalls: rpc.rpcCalls };
      },
    });
    scannedSubjects.push(subjectWallet);
    scanLogs = dedupeLogs([...scanLogs, ...scanned.logs]);
    scanParsed = [...scanParsed, ...scanned.parsed];
    fetchStats = scanned.stats;
  }

  const onChainResolution = new OnChainResolutionCache();
  onChainResolution.seedFromLogs(scanLogs);

  const blockNumbers = new Set<number>();
  for (const item of scanParsed) {
    if (item.type !== "unparsed") blockNumbers.add(item.event.blockNumber);
  }
  const blockTimestamps = new Map<number, number>();
  for (const block of blockNumbers) {
    const ts = await rpc.getBlockTimestamp(block);
    if (ts) blockTimestamps.set(block, ts);
  }
  for (const event of apiEvents) {
    if (event.blockNumber && !blockTimestamps.has(event.blockNumber)) {
      const ts = await rpc.getBlockTimestamp(event.blockNumber);
      if (ts) blockTimestamps.set(event.blockNumber, ts);
    }
  }

  const chainEventMap = new Map<string, WalletLedgerEvent>();
  for (const subjectWallet of scanSubjects) {
    const { events: subjectChainEvents } = parsedEventsToLedgerEvents(
      scanParsed,
      subjectWallet,
      blockTimestamps
    );
    for (const event of subjectChainEvents) {
      chainEventMap.set(event.dedupeKey, event);
    }
  }
  const chainOnlyEvents = [...chainEventMap.values()];
  const combinedEvents = mergeApiAndChainEvents(apiEvents, chainOnlyEvents);

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
    if (resolved) {
      gammaCache.seed(entry.conditionId, resolved);
    }
  }

  const apiLifecycle = await buildPositionLifecycles(
    historyWallet,
    apiEvents,
    gammaCache
  );
  const combinedLifecycle = await buildPositionLifecycles(
    historyWallet,
    combinedEvents,
    gammaCache
  );

  const mergeSplit = analyzeMergeSplitImpact(combinedLifecycle.positions);
  const reconciliation = reconcileApiAndChainTrades(
    activity.rows,
    trades.rows,
    chainOnlyEvents
  );

  const fullWindowScanned =
    scanStart <= window.startBlock &&
    scanEnd >= window.endBlock &&
    scanEnd - scanStart >= window.endBlock - window.startBlock;

  const coverage = buildCoverageReport({
    window,
    apiEvents,
    chainEvents: chainOnlyEvents,
    scanStart,
    scanEnd,
    onChainHistoryComplete:
      fullWindowScanned && window.onChainHistoryComplete === true,
  });

  const distinctMarkets = new Set(
    combinedLifecycle.positions.map((p) => p.conditionId).filter(Boolean)
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

  const combinedMetrics = computeWalletLedgerMetrics({
    positions: combinedLifecycle.positions,
    identity: historyIdentity,
    activityTruncated: activity.truncated,
    tradesTruncated: trades.truncated,
    rawEventCount: combinedEvents.length,
    deduplicatedEventCount: combinedEvents.length,
    gammaCoverage,
    mergeSplit,
    hasHistoryEvents: combinedEvents.length > 0,
  });

  const mergeSplitVerdict =
    mergeSplit.recommendation === "phase_2c_accounting_required"
      ? ("PARTIAL" as const)
      : mergeSplit.positionsWithMergeSplit > 0
        ? ("PARTIAL" as const)
        : ("NO" as const);

  return {
    label: input.label,
    wallet,
    identity,
    fetchStats,
    coverage,
    reconciliation,
    apiLedgerMetrics: apiMetrics,
    combinedLedgerMetrics: combinedMetrics,
    apiOnlyPositions: apiLifecycle.positions.length,
    combinedPositions: combinedLifecycle.positions.length,
    mergeSplitVerdict,
    mergeSplitNotes: [
      `scan_subjects=${scannedSubjects.join(",") || wallet}`,
      `positions_with_merge_split=${mergeSplit.positionsWithMergeSplit}`,
      `ambiguous=${mergeSplit.ambiguousMergeSplit}`,
      `recommendation=${mergeSplit.recommendation}`,
      "on_chain_split_merge_events_captured_but_full_pnl_accounting_not_implemented",
    ],
  };
}

export function estimateOnChainFeasibility(input: {
  wallets: number;
  avgBlocksPerWallet?: number;
  rpcCallsPerBlockBatch?: number;
}): FeasibilityEstimate {
  const blocks = input.avgBlocksPerWallet ?? 500_000;
  const callsPerBatch = input.rpcCallsPerBlockBatch ?? 8;
  const batchSize = 9_999;
  const batches = Math.ceil(blocks / batchSize);
  const rpcCalls = input.wallets * batches * callsPerBatch;
  const secondsPerCall = 0.15;
  const durationMinutes = (rpcCalls * secondsPerCall) / 60;

  return {
    wallets: input.wallets,
    estimatedRpcCalls: rpcCalls,
    estimatedBlocksScanned: input.wallets * blocks,
    estimatedDurationMinutes: durationMinutes,
    notes: [
      "direct_rpc_scanning_scales_linearly_with_wallets_and_history_depth",
      "public_rpc_endpoints_rate_limit_heavily_at_whale_scale",
      "indexed_provider_or_persistent_index_recommended_above_100_wallets",
    ],
  };
}
