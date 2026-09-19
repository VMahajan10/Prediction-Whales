import {
  cacheKey,
  isIndexedLogCacheEnabled,
  readIndexedCache,
  writeIndexedCache,
} from "@/lib/walletLedger/indexed/cache";
import {
  buildQueryCheckpointKey,
  type QueryCheckpointIdentity,
} from "@/lib/walletLedger/indexed/checkpoint";
import {
  describeEtherscanQueryLabel,
  type EtherscanProgressReporter,
} from "@/lib/walletLedger/indexed/auditProgress";
import {
  EtherscanPhaseMetricsCollector,
  setActiveEtherscanPhaseMetricsCollector,
  stashEtherscanPhaseMetricsSummary,
} from "@/lib/walletLedger/indexed/etherscanPhaseMetrics";
import { EventLoopDelayMonitor } from "@/lib/walletLedger/indexed/eventLoopMonitor";
import { buildWalletLogQueries } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import { appendAll } from "@/lib/walletLedger/indexed/arrayUtils";
import { isEtherscanQueryMaxRuntimeError } from "@/lib/walletLedger/indexed/etherscanErrors";
import { auditLog } from "@/lib/walletLedger/indexed/auditProgress";
import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import type {
  IndexedFetchStats,
  IndexedLogProvider,
} from "@/lib/walletLedger/indexed/types";
import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import { decodeLog } from "@/lib/walletLedger/onchain/decode";
import { fetchWalletOnChainLogs } from "@/lib/walletLedger/onchain/fetcher";
import { dedupeLogs } from "@/lib/walletLedger/onchain/rpc";
import type { ParsedOnChainEvent, RpcLog } from "@/lib/walletLedger/onchain/types";

const POLYGON_CHAIN_ID = "137";

export interface FetchIndexedWalletHistoryInput {
  provider: IndexedLogProvider;
  wallet: string;
  fromBlock: number;
  toBlock: number;
  useCache?: boolean;
  interPageDelayMs?: number;
  onProgress?: (stats: IndexedFetchStats) => void;
  resumeCheckpoint?: boolean;
  etherscanProgress?: EtherscanProgressReporter;
  abortSignal?: AbortSignal;
}

export interface FetchIndexedWalletHistoryResult {
  logs: RpcLog[];
  parsed: ParsedOnChainEvent[];
  stats: IndexedFetchStats;
  queriesExecuted: number;
  queryDiagnostics?: {
    emptyRequests: number;
    nonEmptyRequests: number;
    retryAttempts: number;
    retryErrors: string[];
    rangesQueried?: number;
    rangesSplit?: number;
    pagesFetched?: number;
    requestsPerSecond?: number;
  };
}

function buildCheckpointIdentity(
  providerId: string,
  wallet: string,
  query: {
    address: string;
    fromBlock: number;
    topics?: (string | string[] | null)[];
  }
): QueryCheckpointIdentity {
  return {
    providerId,
    chainId: POLYGON_CHAIN_ID,
    wallet: wallet.toLowerCase(),
    contract: query.address.toLowerCase(),
    stableFromBlock: query.fromBlock,
    topics: query.topics ?? [],
  };
}

export async function fetchIndexedWalletHistory(
  input: FetchIndexedWalletHistoryInput
): Promise<FetchIndexedWalletHistoryResult> {
  const wallet = input.wallet.toLowerCase();
  const key = cacheKey([
    input.provider.id,
    wallet,
    String(input.fromBlock),
    String(input.toBlock),
    "wallet_history",
  ]);

  const cacheEnabled =
    input.useCache !== false && isIndexedLogCacheEnabled(input.provider.id);
  if (cacheEnabled) {
    const cached = readIndexedCache<FetchIndexedWalletHistoryResult>(key);
    if (cached) return cached;
  }

  if (input.provider.id === "full_history_rpc") {
    const full = await fetchWalletOnChainLogs({
      wallet,
      fromBlock: input.fromBlock,
      toBlock: input.toBlock,
      interBatchDelayMs: input.interPageDelayMs ?? 75,
      onProgress: (rpcStats) => {
        input.onProgress?.({
          requests: rpcStats.rpcCalls,
          pages: 0,
          logsReturned: rpcStats.logsReturned,
          blockWindows: Math.ceil(
            (input.toBlock - input.fromBlock + 1) / 9_999
          ),
          elapsedMs: rpcStats.elapsedMs,
          currentFromBlock: rpcStats.currentFromBlock,
          currentToBlock: rpcStats.currentToBlock,
          rateLimitHits: rpcStats.rateLimitHits,
          errors: rpcStats.errors,
          uniqueTransactions: rpcStats.uniqueTransactions,
        });
      },
    });
    const output: FetchIndexedWalletHistoryResult = {
      logs: full.logs,
      parsed: full.parsed,
      stats: {
        requests: full.stats.rpcCalls,
        pages: 0,
        logsReturned: full.logs.length,
        blockWindows: Math.ceil((input.toBlock - input.fromBlock + 1) / 9_999),
        elapsedMs: full.stats.elapsedMs,
        currentFromBlock: input.fromBlock,
        currentToBlock: input.toBlock,
        rateLimitHits: full.stats.rateLimitHits,
        errors: full.stats.errors,
        uniqueTransactions: full.stats.uniqueTransactions,
      },
      queriesExecuted: buildWalletLogQueries(wallet, input.fromBlock, input.toBlock)
        .length,
    };
    if (cacheEnabled) writeIndexedCache(key, output);
    return output;
  }

  const queries = buildWalletLogQueries(wallet, input.fromBlock, input.toBlock);
  input.etherscanProgress?.setQueryTotal(queries.length);
  const phaseMetrics = new EtherscanPhaseMetricsCollector();
  phaseMetrics.beginWallet(wallet);
  setActiveEtherscanPhaseMetricsCollector(phaseMetrics);
  const eventLoopMonitor = new EventLoopDelayMonitor();
  eventLoopMonitor.start();
  const started = Date.now();
  const requestsAtStart =
    input.provider instanceof EtherscanV2LogProvider ? input.provider.requests : 0;
  const rateLimitHitsAtStart =
    input.provider instanceof EtherscanV2LogProvider
      ? input.provider.rateLimitHits
      : 0;
  const aggregate: IndexedFetchStats = {
    requests: 0,
    pages: 0,
    logsReturned: 0,
    blockWindows: 0,
    elapsedMs: 0,
    currentFromBlock: input.fromBlock,
    currentToBlock: input.toBlock,
    rateLimitHits: 0,
    errors: [],
    uniqueTransactions: 0,
  };

  const allLogs: RpcLog[] = [];

  try {
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex]!;
    const queryLabel = describeEtherscanQueryLabel(query);
    const paginateOptions: {
      interPageDelayMs?: number;
      onProgress?: (stats: IndexedFetchStats) => void;
      checkpointKey?: string;
      checkpointIdentity?: QueryCheckpointIdentity;
      resumeCheckpoint?: boolean;
      progress?: EtherscanProgressReporter;
      queryIndex?: number;
      queryTotal?: number;
      queryLabel?: string;
      wallet?: string;
      abortSignal?: AbortSignal;
    } = {
      interPageDelayMs: input.interPageDelayMs,
      onProgress: (progress) => {
        aggregate.logsReturned = allLogs.length + progress.logsReturned;
        aggregate.elapsedMs = Date.now() - started;
        input.onProgress?.({ ...aggregate });
        input.etherscanProgress?.updateCounts({
          requests:
            input.provider instanceof EtherscanV2LogProvider
              ? input.provider.requests - requestsAtStart
              : aggregate.requests,
          pages:
            input.provider instanceof EtherscanV2LogProvider
              ? input.provider.pagesFetched
              : aggregate.pages,
          logs: allLogs.length + progress.logsReturned,
          splits:
            input.provider instanceof EtherscanV2LogProvider
              ? input.provider.rangesSplit
              : 0,
          rateLimitHits:
            input.provider instanceof EtherscanV2LogProvider
              ? input.provider.rateLimitHits - rateLimitHitsAtStart
              : aggregate.rateLimitHits,
        });
      },
      resumeCheckpoint: input.resumeCheckpoint,
      progress: input.etherscanProgress,
      queryIndex: queryIndex + 1,
      queryTotal: queries.length,
      queryLabel,
      wallet,
      abortSignal: input.abortSignal,
    };
    if (input.provider.id === "etherscan_v2") {
      const checkpointIdentity = buildCheckpointIdentity(
        input.provider.id,
        wallet,
        query
      );
      paginateOptions.checkpointIdentity = checkpointIdentity;
      paginateOptions.checkpointKey = buildQueryCheckpointKey(checkpointIdentity);
    }
    let logs: RpcLog[];
    let stats: IndexedFetchStats;
    try {
      ({ logs, stats } = await input.provider.getLogsPaginated(query, paginateOptions));
    } catch (error) {
      if (isEtherscanQueryMaxRuntimeError(error)) {
        auditLog(
          `[etherscan-query-defer] wallet=${wallet} stopping indexed history after query ${queryIndex + 1}/${queries.length}`
        );
      }
      throw error;
    }
    appendAll(allLogs, logs);
    aggregate.pages += stats.pages;
    aggregate.blockWindows += stats.blockWindows;
    aggregate.rateLimitHits += stats.rateLimitHits;
    aggregate.errors = [...new Set([...aggregate.errors, ...stats.errors])];
  }
  } finally {
    eventLoopMonitor.logSnapshot(`wallet=${wallet}`);
    stashEtherscanPhaseMetricsSummary(phaseMetrics.summarize());
    setActiveEtherscanPhaseMetricsCollector(null);
    eventLoopMonitor.stop();
  }

  if (input.provider instanceof EtherscanV2LogProvider) {
    aggregate.requests = input.provider.requests - requestsAtStart;
    aggregate.rateLimitHits =
      input.provider.rateLimitHits - rateLimitHitsAtStart;
  }

  const deduped = dedupeLogs(allLogs);
  aggregate.logsReturned = deduped.length;
  aggregate.uniqueTransactions = new Set(deduped.map((l) => l.transactionHash)).size;
  aggregate.elapsedMs = Date.now() - started;

  const providerDiagnostics =
    input.provider instanceof EtherscanV2LogProvider
      ? {
          emptyRequests: input.provider.emptyRequests,
          nonEmptyRequests: input.provider.nonEmptyRequests,
          retryAttempts: input.provider.retryAttempts,
          retryErrors: [...input.provider.retryErrors],
          rangesQueried: input.provider.rangesQueried,
          rangesSplit: input.provider.rangesSplit,
          pagesFetched: input.provider.pagesFetched,
          requestsPerSecond: input.provider.rateLimiter.requestsPerSecond,
        }
      : undefined;

  const output: FetchIndexedWalletHistoryResult = {
    logs: deduped,
    parsed: deduped.map((log) => decodeLog(log)),
    stats: aggregate,
    queriesExecuted: queries.length,
    queryDiagnostics: providerDiagnostics,
  };

  if (cacheEnabled) writeIndexedCache(key, output);
  return output;
}

export function defaultWalletHistoryFromBlock(
  apiOldestBlock: number | null,
  headBlock: number,
  fullHistory: boolean
): number {
  if (fullHistory) return POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  if (apiOldestBlock != null) {
    return Math.max(POLYMARKET_EXCHANGE_INITIAL_BLOCK, apiOldestBlock - 500_000);
  }
  return Math.max(POLYMARKET_EXCHANGE_INITIAL_BLOCK, headBlock - 500_000);
}
