import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import { parseBlockNumber, PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import type { ActivityApiRow, TradeApiRow } from "@/lib/walletLedger/types";

export interface ApiSourceTimestamps {
  oldestActivityTimestamp: number | null;
  oldestTradesTimestamp: number | null;
  /** Reporting-only blended min(activity, trades). Not used for truncation immunity. */
  apiOldestTimestamp: number | null;
  apiNewestTimestamp: number | null;
}

export function extractApiSourceTimestamps(
  activityRows: ActivityApiRow[],
  tradeRows: TradeApiRow[]
): ApiSourceTimestamps {
  const activityTs = activityRows
    .map((row) => Number(row.timestamp ?? 0))
    .filter((ts) => ts > 0);
  const tradeTs = tradeRows
    .map((row) => Number(row.timestamp ?? 0))
    .filter((ts) => ts > 0);
  const oldestActivityTimestamp =
    activityTs.length > 0 ? Math.min(...activityTs) : null;
  const oldestTradesTimestamp =
    tradeTs.length > 0 ? Math.min(...tradeTs) : null;
  const blended = [...activityTs, ...tradeTs];
  return {
    oldestActivityTimestamp,
    oldestTradesTimestamp,
    apiOldestTimestamp: blended.length > 0 ? Math.min(...blended) : null,
    apiNewestTimestamp: blended.length > 0 ? Math.max(...blended) : null,
  };
}

export interface WalletStartBlockResult {
  startBlock: number;
  endBlock: number;
  oldestActivityTimestamp: number | null;
  oldestTradesTimestamp: number | null;
  /** @deprecated Reporting-only. Use oldestActivityTimestamp / oldestTradesTimestamp for immunity. */
  apiOldestTimestamp: number | null;
  apiNewestTimestamp: number | null;
  apiOldestBlock: number | null;
  apiNewestBlock: number | null;
  verifiedOldestBlock: number | null;
  apiTxHashes: string[];
  completenessNotes: string[];
  onChainHistoryComplete: boolean;
}

export function sampleTxHashes(
  activityRows: ActivityApiRow[],
  tradeRows: TradeApiRow[],
  extraTxHashes: string[] = [],
  limit = 400
): string[] {
  const byTime: Array<{ ts: number; hash: string }> = [];
  for (const row of activityRows) {
    if (!row.transactionHash) continue;
    byTime.push({
      ts: Number(row.timestamp ?? 0),
      hash: row.transactionHash.toLowerCase(),
    });
  }
  for (const row of tradeRows) {
    if (!row.transactionHash) continue;
    byTime.push({
      ts: Number(row.timestamp ?? 0),
      hash: row.transactionHash.toLowerCase(),
    });
  }
  byTime.sort((a, b) => a.ts - b.ts);
  const hashes = new Set<string>(extraTxHashes.map((h) => h.toLowerCase()));
  const oldest = byTime.slice(0, Math.floor(limit / 2));
  const newest = byTime.slice(-Math.floor(limit / 2));
  for (const row of [...oldest, ...newest]) hashes.add(row.hash);
  return [...hashes].slice(0, limit);
}

export async function determineWalletBlockWindow(input: {
  activityRows: ActivityApiRow[];
  tradeRows: TradeApiRow[];
  extraTxHashes?: string[];
  lookbackBlocks?: number;
  txSampleLimit?: number;
  rpc?: PolygonRpcClient;
}): Promise<WalletStartBlockResult> {
  const rpc = input.rpc ?? new PolygonRpcClient();
  const lookback = input.lookbackBlocks ?? 500_000;
  const notes: string[] = [];

  const sourceTimestamps = extractApiSourceTimestamps(
    input.activityRows,
    input.tradeRows
  );

  const txHashes = sampleTxHashes(
    input.activityRows,
    input.tradeRows,
    input.extraTxHashes,
    input.txSampleLimit ?? 400
  );
  notes.push(`tx_hash_sample_size=${txHashes.length}`);

  const blocks: number[] = [];
  for (const hash of txHashes) {
    const receipt = await rpc.getTransactionReceipt(hash);
    if (receipt?.blockNumber) {
      blocks.push(parseBlockNumber(receipt.blockNumber));
    }
  }

  const apiOldestTimestamp = sourceTimestamps.apiOldestTimestamp;
  const apiNewestTimestamp = sourceTimestamps.apiNewestTimestamp;
  const apiOldestBlock = blocks.length ? Math.min(...blocks) : null;
  const apiNewestBlock = blocks.length ? Math.max(...blocks) : null;
  const verifiedOldestBlock = apiOldestBlock;

  const head =
    (await rpc.getBlockNumber()) ??
    apiNewestBlock ??
    POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  const endBlock = head;

  let startBlock = POLYMARKET_EXCHANGE_INITIAL_BLOCK;
  if (apiOldestBlock != null) {
    startBlock = Math.max(
      POLYMARKET_EXCHANGE_INITIAL_BLOCK,
      apiOldestBlock - lookback
    );
    notes.push(`api_oldest_block=${apiOldestBlock}_lookback=${lookback}`);
  } else {
    notes.push("no_api_tx_blocks_using_exchange_initial_block");
  }

  const onChainHistoryComplete = false;
  notes.push("full_wallet_history_not_proven_without_complete_block_scan");

  return {
    startBlock,
    endBlock,
    oldestActivityTimestamp: sourceTimestamps.oldestActivityTimestamp,
    oldestTradesTimestamp: sourceTimestamps.oldestTradesTimestamp,
    apiOldestTimestamp,
    apiNewestTimestamp,
    apiOldestBlock,
    apiNewestBlock,
    verifiedOldestBlock,
    apiTxHashes: txHashes,
    completenessNotes: notes,
    onChainHistoryComplete,
  };
}
