export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  blockHash?: string;
  transactionIndex?: string;
  removed?: boolean;
}

export interface RpcTransactionReceipt {
  blockNumber: string;
  transactionHash: string;
  logs: RpcLog[];
}

export interface OnChainFetchProgress {
  blocksScanned: number;
  rpcCalls: number;
  logsReturned: number;
  uniqueTransactions: number;
  elapsedMs: number;
  currentFromBlock: number;
  currentToBlock: number;
}

export interface OnChainFetchStats extends OnChainFetchProgress {
  rateLimitHits: number;
  retries: number;
  errors: string[];
}

export interface ParsedOrderFilled {
  kind: "order_filled_v1" | "order_filled_neg_risk";
  orderHash: string;
  maker: string;
  taker: string;
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
  fee?: bigint;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  contractAddress: string;
}

export interface ParsedErc1155Transfer {
  operator: string;
  from: string;
  to: string;
  tokenId: string;
  value: bigint;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface ParsedConditionResolution {
  conditionId: string;
  oracle: string;
  questionId: string;
  outcomeSlotCount: number;
  payoutNumerators: bigint[];
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface ParsedPositionSplit {
  stakeholder: string;
  collateralToken: string;
  parentCollectionId: string;
  conditionId: string;
  amount: bigint;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface ParsedPositionsMerge {
  stakeholder: string;
  collateralToken: string;
  parentCollectionId: string;
  conditionId: string;
  amount: bigint;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface ParsedPayoutRedemption {
  redeemer: string;
  collateralToken: string;
  parentCollectionId: string;
  conditionId: string;
  payout: bigint;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export type ParsedOnChainEvent =
  | { type: "order_filled"; event: ParsedOrderFilled }
  | { type: "erc1155_transfer"; event: ParsedErc1155Transfer }
  | { type: "condition_resolution"; event: ParsedConditionResolution }
  | { type: "position_split"; event: ParsedPositionSplit }
  | { type: "positions_merge"; event: ParsedPositionsMerge }
  | { type: "payout_redemption"; event: ParsedPayoutRedemption }
  | { type: "unparsed"; raw: RpcLog; reason: string };

export interface OnChainWalletIdentityReport {
  requestedWallet: string;
  relatedAddresses: string[];
  relationshipEvidence: Array<{
    address: string;
    role: string;
    evidence: string;
  }>;
  canonicalHistorySubjects: string[];
  confidence: "high" | "medium" | "low";
}

export interface OnChainCoverageReport {
  apiOldestTimestamp: number | null;
  apiNewestTimestamp: number | null;
  apiOldestBlock: number | null;
  apiNewestBlock: number | null;
  chainOldestTimestamp: number | null;
  chainNewestTimestamp: number | null;
  chainOldestBlock: number | null;
  chainNewestBlock: number | null;
  apiEventCount: number;
  chainEventCount: number;
  additionalHistoricalEvents: number;
  scanStartBlock: number;
  scanEndBlock: number;
  onChainHistoryComplete: boolean;
  completenessNotes: string[];
}

export interface ReconciliationReport {
  apiTradeCount: number;
  chainTradeCount: number;
  matchedEvents: number;
  apiOnlyEvents: number;
  chainOnlyEvents: number;
  matchRate: number;
  samples: Array<{
    status: "matched" | "api_only" | "chain_only";
    txHash: string;
    detail: string;
  }>;
}

export interface OnChainAuditWalletResult {
  label: string;
  wallet: string;
  identity: OnChainWalletIdentityReport;
  fetchStats: OnChainFetchStats;
  coverage: OnChainCoverageReport;
  reconciliation: ReconciliationReport;
  apiLedgerMetrics: ReturnType<
    typeof import("@/lib/walletLedger/metrics").computeWalletLedgerMetrics
  > | null;
  combinedLedgerMetrics: ReturnType<
    typeof import("@/lib/walletLedger/metrics").computeWalletLedgerMetrics
  > | null;
  apiOnlyPositions: number;
  combinedPositions: number;
  mergeSplitVerdict: "YES" | "PARTIAL" | "NO";
  mergeSplitNotes: string[];
}

export interface FeasibilityEstimate {
  wallets: number;
  estimatedRpcCalls: number;
  estimatedBlocksScanned: number;
  estimatedDurationMinutes: number;
  notes: string[];
}
