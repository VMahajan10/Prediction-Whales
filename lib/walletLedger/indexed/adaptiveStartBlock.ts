import { EtherscanV2LogProvider } from "@/lib/walletLedger/indexed/providers/etherscan";
import {
  EXCHANGE_ADDRESSES,
  POLYMARKET_EXCHANGE_INITIAL_BLOCK,
} from "@/lib/walletLedger/onchain/contracts";
import { parseBlockNumber, PolygonRpcClient } from "@/lib/walletLedger/onchain/rpc";
import type { TradeApiRow } from "@/lib/walletLedger/types";

/** Conservative Polygon floor — never scan earlier than exchange contracts existed. */
export const POLYMARKET_CONTRACT_DEPLOYMENT_FLOOR = 35_000_000;

export const ADAPTIVE_START_BLOCK_BUFFER = 10_000;

/**
 * Wallet-scoped pilot overrides from read-only chain evidence (not a global constant).
 */
export const PILOT_PROVEN_EARLIEST_BLOCKS: Readonly<Record<string, number>> = {
  "0xd27cc742d023d06ef633a4c880cf1ff1836ec081": 48_565_033,
};

/**
 * Earliest verified relevant on-chain event block from read-only scans (wallet-scoped).
 */
export const VERIFIED_RELEVANT_CHAIN_EVENT_BLOCKS: Readonly<
  Record<string, number>
> = {
  "0xd27cc742d023d06ef633a4c880cf1ff1836ec081": 48_565_033,
};

export type AdaptiveEarliestSource =
  | "verified_trade"
  | "verified_chain_event"
  | "pilot_proven"
  | "exchange_initial_block_fallback";

export interface VerifiedTradeTxEvidence {
  txHash: string;
  apiTimestamp: number | null;
  verifiedOnPolygon: boolean;
  blockNumber: number | null;
  blockTimestamp: number | null;
  exchangeContracts: string[];
  conditionalTokensPresent: boolean;
  classification: "verified_polygon_trade" | "unverified_api_history";
}

export interface AdaptiveFromBlockResult {
  fromBlock: number;
  reason: string;
  usedPilotOverride: boolean;
  /** @deprecated Use verifiedOldestTradeBlock */
  verifiedOldestBlock: number | null;
  verifiedOldestTradeBlock: number | null;
  verifiedRelevantChainEventBlock: number | null;
  pilotProvenEarliestBlock: number | null;
  earliestRelevantBlock: number | null;
  contributingSource: AdaptiveEarliestSource;
}

export function oldestTradeRowsForVerification(
  tradeRows: TradeApiRow[],
  limit = 10
): TradeApiRow[] {
  return [...tradeRows]
    .filter((row) => row.transactionHash)
    .sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0))
    .slice(0, limit);
}

export async function verifyTradeTxOnPolygon(
  txHash: string,
  options?: {
    rpc?: PolygonRpcClient;
    etherscan?: EtherscanV2LogProvider;
  }
): Promise<VerifiedTradeTxEvidence> {
  const rpc = options?.rpc ?? new PolygonRpcClient();
  const etherscan = options?.etherscan ?? new EtherscanV2LogProvider();
  const receipt = await rpc.getTransactionReceipt(txHash);
  let logs = receipt?.logs ?? [];
  if (logs.length === 0 && etherscan.getLogsByTxHash) {
    logs = await etherscan.getLogsByTxHash(txHash);
  }
  const blockNumber =
    receipt?.blockNumber != null
      ? parseBlockNumber(receipt.blockNumber)
      : logs[0]?.blockNumber != null
        ? parseBlockNumber(logs[0].blockNumber)
        : null;
  const blockTimestamp =
    blockNumber != null ? await rpc.getBlockTimestamp(blockNumber) : null;
  const contracts = [...new Set(logs.map((log) => log.address.toLowerCase()))];
  const exchangeContracts = contracts.filter((address) =>
    EXCHANGE_ADDRESSES.includes(address as (typeof EXCHANGE_ADDRESSES)[number])
  );
  const verifiedOnPolygon = blockNumber != null && logs.length > 0;
  return {
    txHash: txHash.toLowerCase(),
    apiTimestamp: null,
    verifiedOnPolygon,
    blockNumber,
    blockTimestamp,
    exchangeContracts,
    conditionalTokensPresent: contracts.some(
      (c) => c === "0x4d97dcd97ec945f40cf65f87097ace5ea0476045"
    ),
    classification: verifiedOnPolygon
      ? "verified_polygon_trade"
      : "unverified_api_history",
  };
}

export async function verifyOldestTradeTxHashes(
  tradeRows: TradeApiRow[],
  limit = 10
): Promise<VerifiedTradeTxEvidence[]> {
  const oldest = oldestTradeRowsForVerification(tradeRows, limit);
  const rpc = new PolygonRpcClient();
  const etherscan = new EtherscanV2LogProvider();
  const results: VerifiedTradeTxEvidence[] = [];
  for (const row of oldest) {
    const txHash = row.transactionHash!.toLowerCase();
    const evidence = await verifyTradeTxOnPolygon(txHash, { rpc, etherscan });
    evidence.apiTimestamp = row.timestamp != null ? Number(row.timestamp) : null;
    results.push(evidence);
  }
  return results;
}

export function verifiedOldestBlockFromEvidence(
  evidence: VerifiedTradeTxEvidence[]
): number | null {
  const blocks = evidence
    .filter((row) => row.verifiedOnPolygon && row.blockNumber != null)
    .map((row) => row.blockNumber!);
  return blocks.length > 0 ? Math.min(...blocks) : null;
}

function selectEarliestRelevantBlock(input: {
  pilotProvenEarliestBlock: number | null;
  verifiedOldestTradeBlock: number | null;
  verifiedRelevantChainEventBlock: number | null;
}): { block: number | null; source: AdaptiveEarliestSource } {
  const candidates: Array<{ block: number; source: AdaptiveEarliestSource }> =
    [];
  if (input.pilotProvenEarliestBlock != null) {
    candidates.push({
      block: input.pilotProvenEarliestBlock,
      source: "pilot_proven",
    });
  }
  if (input.verifiedOldestTradeBlock != null) {
    candidates.push({
      block: input.verifiedOldestTradeBlock,
      source: "verified_trade",
    });
  }
  if (input.verifiedRelevantChainEventBlock != null) {
    candidates.push({
      block: input.verifiedRelevantChainEventBlock,
      source: "verified_chain_event",
    });
  }
  if (candidates.length === 0) {
    return { block: null, source: "exchange_initial_block_fallback" };
  }
  return candidates.reduce((min, candidate) =>
    candidate.block < min.block ? candidate : min
  );
}

/**
 * Select fromBlock as min(pilot proven, verified trade block, verified chain event block)
 * minus safety buffer. Never uses unverified API tx hashes.
 */
export function resolveAdaptiveFromBlock(input: {
  wallet: string;
  incrementalFromBlock: number;
  fullHistory: boolean;
  verifiedOldestTradeBlock: number | null;
  verifiedRelevantChainEventBlock?: number | null;
  pilotProvenEarliestBlock?: number | null;
  allowEarlierThanIncremental?: boolean;
  lookbackBuffer?: number;
}): AdaptiveFromBlockResult {
  const wallet = input.wallet.toLowerCase();
  const buffer = input.lookbackBuffer ?? ADAPTIVE_START_BLOCK_BUFFER;
  const pilotBlock =
    input.pilotProvenEarliestBlock ??
    PILOT_PROVEN_EARLIEST_BLOCKS[wallet] ??
    null;
  const verifiedChainEventBlock =
    input.verifiedRelevantChainEventBlock ??
    VERIFIED_RELEVANT_CHAIN_EVENT_BLOCKS[wallet] ??
    null;

  const isIncremental =
    !input.allowEarlierThanIncremental &&
    input.incrementalFromBlock > POLYMARKET_EXCHANGE_INITIAL_BLOCK;

  if (isIncremental) {
    return {
      fromBlock: input.incrementalFromBlock,
      reason: "incremental_checkpoint",
      usedPilotOverride: false,
      verifiedOldestBlock: input.verifiedOldestTradeBlock,
      verifiedOldestTradeBlock: input.verifiedOldestTradeBlock,
      verifiedRelevantChainEventBlock: verifiedChainEventBlock,
      pilotProvenEarliestBlock: pilotBlock,
      earliestRelevantBlock: null,
      contributingSource: "exchange_initial_block_fallback",
    };
  }

  const earliest = selectEarliestRelevantBlock({
    pilotProvenEarliestBlock: pilotBlock,
    verifiedOldestTradeBlock: input.verifiedOldestTradeBlock,
    verifiedRelevantChainEventBlock: verifiedChainEventBlock,
  });

  const fromBlock =
    earliest.block != null
      ? Math.max(POLYMARKET_CONTRACT_DEPLOYMENT_FLOOR, earliest.block - buffer)
      : POLYMARKET_EXCHANGE_INITIAL_BLOCK;

  const reason =
    earliest.block != null
      ? `${earliest.source}_block_${earliest.block}_minus_${buffer}`
      : "exchange_initial_block_fallback";

  return {
    fromBlock,
    reason,
    usedPilotOverride: earliest.source === "pilot_proven",
    verifiedOldestBlock: input.verifiedOldestTradeBlock,
    verifiedOldestTradeBlock: input.verifiedOldestTradeBlock,
    verifiedRelevantChainEventBlock: verifiedChainEventBlock,
    pilotProvenEarliestBlock: pilotBlock,
    earliestRelevantBlock: earliest.block,
    contributingSource: earliest.source,
  };
}
