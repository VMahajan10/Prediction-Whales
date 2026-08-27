import {
  CONDITIONAL_TOKENS_ADDRESS,
  EXCHANGE_ADDRESSES,
  ORDER_FILLED_TOPICS,
  TOPIC_POSITION_SPLIT,
  TOPIC_POSITIONS_MERGE,
  TOPIC_PAYOUT_REDEMPTION,
} from "@/lib/walletLedger/onchain/contracts";
import { fetchWalletOnChainLogs } from "@/lib/walletLedger/onchain/fetcher";
import { PolygonRpcClient, walletTopic } from "@/lib/walletLedger/onchain/rpc";
import type {
  IndexedFetchStats,
  IndexedLogProvider,
  IndexedLogQuery,
  IndexedProviderCapabilities,
  IndexedProviderProbeResult,
} from "@/lib/walletLedger/indexed/types";
import type { RpcLog } from "@/lib/walletLedger/onchain/types";

const CAPABILITIES: IndexedProviderCapabilities = {
  walletTopicFilter: true,
  contractFilter: true,
  blockRangeFilter: true,
  txHashLookup: true,
  cursorPagination: false,
  pagePagination: false,
  maxBlockRangePerRequest: 9_999,
  maxResultsPerPage: null,
  requiresApiKey: false,
  estimatedCostTier: "free",
};

/**
 * Non-indexed baseline: scans block ranges via eth_getLogs (Phase 2C-style).
 * Included for latency/cost comparison against true indexed providers.
 */
export class FullHistoryRpcProvider implements IndexedLogProvider {
  readonly id = "full_history_rpc" as const;
  readonly name = "Direct Polygon RPC (full block scan)";
  readonly capabilities = CAPABILITIES;

  private readonly rpc: PolygonRpcClient;

  constructor(rpc = new PolygonRpcClient()) {
    this.rpc = rpc;
  }

  async probe(): Promise<IndexedProviderProbeResult> {
    const started = Date.now();
    const head = await this.rpc.getBlockNumber();
    return {
      providerId: this.id,
      available: head != null,
      probeLatencyMs: Date.now() - started,
      error: head == null ? "rpc_unreachable" : null,
      capabilities: this.capabilities,
      notes: [
        "not_a_true_index_requires_per_block_window_eth_getLogs",
        "public_rpc_10k_block_limit",
        "phase2c_observed_900_1400_calls_per_100k_blocks",
      ],
    };
  }

  async getLogs(query: IndexedLogQuery): Promise<RpcLog[]> {
    return this.rpc.getLogs({
      fromBlock: query.fromBlock,
      toBlock: query.toBlock,
      address: query.address,
      topics: query.topics,
    });
  }

  async getLogsPaginated(
    query: Omit<IndexedLogQuery, "page" | "offset">,
    options: {
      offset?: number;
      interPageDelayMs?: number;
      onProgress?: (stats: IndexedFetchStats) => void;
    } = {}
  ): Promise<{ logs: RpcLog[]; stats: IndexedFetchStats }> {
    const { logs, stats } = await fetchWalletOnChainLogs({
      wallet: extractWalletFromTopics(query.topics) ?? "0x0",
      fromBlock: query.fromBlock,
      toBlock: query.toBlock,
      blockBatchSize: options.offset ?? 9_999,
      interBatchDelayMs: options.interPageDelayMs ?? 75,
      rpc: this.rpc,
      onProgress: (rpcStats) => {
        options.onProgress?.({
          requests: rpcStats.rpcCalls,
          pages: 0,
          logsReturned: rpcStats.logsReturned,
          blockWindows: Math.ceil(
            (query.toBlock - query.fromBlock + 1) / (options.offset ?? 9_999)
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

    return {
      logs,
      stats: {
        requests: this.rpc.rpcCalls,
        pages: 0,
        logsReturned: logs.length,
        blockWindows: Math.ceil(
          (query.toBlock - query.fromBlock + 1) / (options.offset ?? 9_999)
        ),
        elapsedMs: stats.elapsedMs,
        currentFromBlock: query.fromBlock,
        currentToBlock: query.toBlock,
        rateLimitHits: stats.rateLimitHits,
        errors: stats.errors,
        uniqueTransactions: stats.uniqueTransactions,
      },
    };
  }

  async getLogsByTxHash(txHash: string): Promise<RpcLog[]> {
    const receipt = await this.rpc.getTransactionReceipt(txHash);
    return receipt?.logs ?? [];
  }
}

function extractWalletFromTopics(
  topics: IndexedLogQuery["topics"]
): string | null {
  if (!topics) return null;
  for (const topic of topics) {
    if (typeof topic === "string" && topic.length === 66) {
      return `0x${topic.slice(26)}`.toLowerCase();
    }
  }
  return null;
}

export function buildWalletLogQueries(
  wallet: string,
  fromBlock: number,
  toBlock: number
): Array<Omit<IndexedLogQuery, "page" | "offset">> {
  const walletTopicPadded = walletTopic(wallet);
  return [
    ...EXCHANGE_ADDRESSES.flatMap((address) => [
      {
        fromBlock,
        toBlock,
        address,
        topics: [[...ORDER_FILLED_TOPICS], null, walletTopicPadded] as (
          | string
          | string[]
          | null
        )[],
      },
      {
        fromBlock,
        toBlock,
        address,
        topics: [[...ORDER_FILLED_TOPICS], null, null, walletTopicPadded] as (
          | string
          | string[]
          | null
        )[],
      },
    ]),
    {
      fromBlock,
      toBlock,
      address: CONDITIONAL_TOKENS_ADDRESS,
      topics: [null, null, walletTopicPadded],
    },
    {
      fromBlock,
      toBlock,
      address: CONDITIONAL_TOKENS_ADDRESS,
      topics: [null, null, null, walletTopicPadded],
    },
    {
      fromBlock,
      toBlock,
      address: CONDITIONAL_TOKENS_ADDRESS,
      topics: [
        [TOPIC_POSITION_SPLIT, TOPIC_POSITIONS_MERGE, TOPIC_PAYOUT_REDEMPTION],
        walletTopicPadded,
      ],
    },
  ];
}
