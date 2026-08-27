import {
  CONDITIONAL_TOKENS_ADDRESS,
  EXCHANGE_ADDRESSES,
  ORDER_FILLED_TOPICS,
  POLYMARKET_EXCHANGE_INITIAL_BLOCK,
  TOPIC_POSITION_SPLIT,
  TOPIC_POSITIONS_MERGE,
  TOPIC_PAYOUT_REDEMPTION,
} from "@/lib/walletLedger/onchain/contracts";
import { decodeLog } from "@/lib/walletLedger/onchain/decode";
import {
  dedupeLogs,
  PolygonRpcClient,
  walletTopic,
} from "@/lib/walletLedger/onchain/rpc";
import type {
  OnChainFetchStats,
  ParsedOnChainEvent,
  RpcLog,
} from "@/lib/walletLedger/onchain/types";

export interface BoundedOnChainFetchOptions {
  wallet: string;
  fromBlock: number;
  toBlock: number;
  blockBatchSize?: number;
  interBatchDelayMs?: number;
  rpc?: PolygonRpcClient;
  onProgress?: (stats: OnChainFetchStats) => void;
}

export interface BoundedOnChainFetchResult {
  logs: RpcLog[];
  parsed: ParsedOnChainEvent[];
  stats: OnChainFetchStats;
}

export async function fetchReceiptLogs(
  rpc: PolygonRpcClient,
  txHashes: string[]
): Promise<RpcLog[]> {
  const logs: RpcLog[] = [];
  for (const hash of txHashes) {
    const receipt = await rpc.getTransactionReceipt(hash);
    if (!receipt?.logs?.length) continue;
    logs.push(...receipt.logs);
  }
  return dedupeLogs(logs);
}

export async function fetchWalletOnChainLogs(
  options: BoundedOnChainFetchOptions
): Promise<BoundedOnChainFetchResult> {
  const rpc = options.rpc ?? new PolygonRpcClient();
  const wallet = options.wallet.toLowerCase();
  const batch = options.blockBatchSize ?? 9_999;
  const delay = options.interBatchDelayMs ?? 100;
  const started = Date.now();
  const stats: OnChainFetchStats = {
    blocksScanned: 0,
    rpcCalls: 0,
    logsReturned: 0,
    uniqueTransactions: 0,
    elapsedMs: 0,
    currentFromBlock: options.fromBlock,
    currentToBlock: options.toBlock,
    rateLimitHits: 0,
    retries: 0,
    errors: [],
  };

  const allLogs: RpcLog[] = [];
  const walletTopicPadded = walletTopic(wallet);

  for (let from = options.fromBlock; from <= options.toBlock; from += batch + 1) {
    const to = Math.min(from + batch, options.toBlock);
    stats.currentFromBlock = from;
    stats.currentToBlock = to;
    stats.blocksScanned += to - from + 1;

  const batchLogs = await Promise.all([
      ...EXCHANGE_ADDRESSES.flatMap((address) => [
        rpc.getLogs({
          fromBlock: from,
          toBlock: to,
          address,
          topics: [[...ORDER_FILLED_TOPICS], null, walletTopicPadded],
        }),
        rpc.getLogs({
          fromBlock: from,
          toBlock: to,
          address,
          topics: [[...ORDER_FILLED_TOPICS], null, null, walletTopicPadded],
        }),
      ]),
      rpc.getLogs({
        fromBlock: from,
        toBlock: to,
        address: CONDITIONAL_TOKENS_ADDRESS,
        topics: [null, null, walletTopicPadded],
      }),
      rpc.getLogs({
        fromBlock: from,
        toBlock: to,
        address: CONDITIONAL_TOKENS_ADDRESS,
        topics: [null, null, null, walletTopicPadded],
      }),
      rpc.getLogs({
        fromBlock: from,
        toBlock: to,
        address: CONDITIONAL_TOKENS_ADDRESS,
        topics: [[TOPIC_POSITION_SPLIT, TOPIC_POSITIONS_MERGE, TOPIC_PAYOUT_REDEMPTION], walletTopicPadded],
      }),
    ]);

    for (const logs of batchLogs) {
      allLogs.push(...logs);
      stats.logsReturned += logs.length;
    }

    stats.rpcCalls = rpc.rpcCalls;
    stats.rateLimitHits = rpc.rateLimitHits;
    stats.retries = rpc.retries;
    stats.errors = rpc.errors;
    stats.elapsedMs = Date.now() - started;
    options.onProgress?.(stats);

    if (delay > 0 && to < options.toBlock) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const deduped = dedupeLogs(allLogs);
  stats.uniqueTransactions = new Set(deduped.map((l) => l.transactionHash)).size;
  stats.elapsedMs = Date.now() - started;

  const parsed = deduped.map((log) => decodeLog(log));
  return { logs: deduped, parsed, stats };
}

export function defaultScanEndBlock(currentBlock: number): number {
  return currentBlock;
}

export function defaultScanStartBlock(
  apiOldestBlock: number | null,
  lookbackBlocks: number
): number {
  const floor = POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  if (!apiOldestBlock) return Math.max(floor, apiOldestBlock ?? floor);
  return Math.max(floor, apiOldestBlock - lookbackBlocks);
}
