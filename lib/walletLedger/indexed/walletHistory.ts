import { cacheKey, readIndexedCache, writeIndexedCache } from "@/lib/walletLedger/indexed/cache";
import { buildWalletLogQueries } from "@/lib/walletLedger/indexed/providers/fullHistoryRpc";
import type {
  IndexedFetchStats,
  IndexedLogProvider,
} from "@/lib/walletLedger/indexed/types";
import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import { decodeLog } from "@/lib/walletLedger/onchain/decode";
import { fetchWalletOnChainLogs } from "@/lib/walletLedger/onchain/fetcher";
import { dedupeLogs } from "@/lib/walletLedger/onchain/rpc";
import type { ParsedOnChainEvent, RpcLog } from "@/lib/walletLedger/onchain/types";

export interface FetchIndexedWalletHistoryInput {
  provider: IndexedLogProvider;
  wallet: string;
  fromBlock: number;
  toBlock: number;
  useCache?: boolean;
  interPageDelayMs?: number;
  onProgress?: (stats: IndexedFetchStats) => void;
}

export interface FetchIndexedWalletHistoryResult {
  logs: RpcLog[];
  parsed: ParsedOnChainEvent[];
  stats: IndexedFetchStats;
  queriesExecuted: number;
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

  if (input.useCache !== false) {
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
    if (input.useCache !== false) writeIndexedCache(key, output);
    return output;
  }

  const queries = buildWalletLogQueries(wallet, input.fromBlock, input.toBlock);
  const started = Date.now();
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

  for (const query of queries) {
    const { logs, stats } = await input.provider.getLogsPaginated(query, {
      interPageDelayMs: input.interPageDelayMs,
      onProgress: (progress) => {
        aggregate.requests = progress.requests;
        aggregate.logsReturned = allLogs.length + progress.logsReturned;
        aggregate.blockWindows += progress.blockWindows;
        aggregate.elapsedMs = Date.now() - started;
        aggregate.rateLimitHits = progress.rateLimitHits;
        aggregate.errors = progress.errors;
        input.onProgress?.({ ...aggregate });
      },
    });
    allLogs.push(...logs);
    aggregate.requests = stats.requests;
    aggregate.pages += stats.pages;
    aggregate.blockWindows += stats.blockWindows;
    aggregate.rateLimitHits = stats.rateLimitHits;
    aggregate.errors = [...new Set([...aggregate.errors, ...stats.errors])];
  }

  const deduped = dedupeLogs(allLogs);
  aggregate.logsReturned = deduped.length;
  aggregate.uniqueTransactions = new Set(deduped.map((l) => l.transactionHash)).size;
  aggregate.elapsedMs = Date.now() - started;

  const output: FetchIndexedWalletHistoryResult = {
    logs: deduped,
    parsed: deduped.map((log) => decodeLog(log)),
    stats: aggregate,
    queriesExecuted: queries.length,
  };

  if (input.useCache !== false) writeIndexedCache(key, output);
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
