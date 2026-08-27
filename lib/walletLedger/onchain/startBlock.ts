import { POLYMARKET_EXCHANGE_INITIAL_BLOCK } from "@/lib/walletLedger/onchain/contracts";
import { parseBlockNumber, PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import type { ActivityApiRow, TradeApiRow } from "@/lib/walletLedger/types";

export interface WalletStartBlockResult {
  startBlock: number;
  endBlock: number;
  apiOldestTimestamp: number | null;
  apiNewestTimestamp: number | null;
  apiOldestBlock: number | null;
  apiNewestBlock: number | null;
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

  const timestamps: number[] = [];
  for (const row of input.activityRows) {
    if (row.timestamp) timestamps.push(Number(row.timestamp));
  }
  for (const row of input.tradeRows) {
    if (row.timestamp) timestamps.push(Number(row.timestamp));
  }

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

  const apiOldestTimestamp = timestamps.length ? Math.min(...timestamps) : null;
  const apiNewestTimestamp = timestamps.length ? Math.max(...timestamps) : null;
  const apiOldestBlock = blocks.length ? Math.min(...blocks) : null;
  const apiNewestBlock = blocks.length ? Math.max(...blocks) : null;

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
    apiOldestTimestamp,
    apiNewestTimestamp,
    apiOldestBlock,
    apiNewestBlock,
    apiTxHashes: txHashes,
    completenessNotes: notes,
    onChainHistoryComplete,
  };
}
