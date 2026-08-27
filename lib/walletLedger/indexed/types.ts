import type { RpcLog } from "@/lib/walletLedger/onchain/types";
import type { WalletLedgerEvent } from "@/lib/walletLedger/types";

export type IndexedProviderId =
  | "etherscan_v2"
  | "blockscout"
  | "full_history_rpc"
  | "phase2c_bounded_rpc";

export interface IndexedProviderCapabilities {
  walletTopicFilter: boolean;
  contractFilter: boolean;
  blockRangeFilter: boolean;
  txHashLookup: boolean;
  cursorPagination: boolean;
  pagePagination: boolean;
  maxBlockRangePerRequest: number | null;
  maxResultsPerPage: number | null;
  requiresApiKey: boolean;
  estimatedCostTier: "free" | "freemium" | "paid";
}

export interface IndexedProviderProbeResult {
  providerId: IndexedProviderId;
  available: boolean;
  probeLatencyMs: number;
  error: string | null;
  capabilities: IndexedProviderCapabilities;
  notes: string[];
}

export interface IndexedFetchProgress {
  requests: number;
  pages: number;
  logsReturned: number;
  blockWindows: number;
  elapsedMs: number;
  currentFromBlock: number;
  currentToBlock: number;
}

export interface IndexedFetchStats extends IndexedFetchProgress {
  rateLimitHits: number;
  errors: string[];
  uniqueTransactions: number;
}

export interface IndexedLogQuery {
  fromBlock: number;
  toBlock: number;
  address: string;
  topics?: (string | string[] | null)[];
  page?: number;
  offset?: number;
}

export interface IndexedLogProvider {
  id: IndexedProviderId;
  name: string;
  capabilities: IndexedProviderCapabilities;
  probe(): Promise<IndexedProviderProbeResult>;
  getLogs(query: IndexedLogQuery): Promise<RpcLog[]>;
  getLogsPaginated(
    query: Omit<IndexedLogQuery, "page" | "offset">,
    options?: {
      offset?: number;
      interPageDelayMs?: number;
      onProgress?: (stats: IndexedFetchStats) => void;
    }
  ): Promise<{ logs: RpcLog[]; stats: IndexedFetchStats }>;
  getLogsByTxHash?(txHash: string): Promise<RpcLog[]>;
}

export interface IndexedWalletCoverageReport {
  apiOldestTimestamp: number | null;
  apiNewestTimestamp: number | null;
  indexedOldestTimestamp: number | null;
  indexedNewestTimestamp: number | null;
  apiEventCount: number;
  indexedEventCount: number;
  eventsBeforeApiBoundary: number;
  additionalCompletedPositions: number;
  scanFromBlock: number;
  scanToBlock: number;
  indexedHistoryComplete: boolean;
  completenessNotes: string[];
}

export interface IndexedAuditWalletResult {
  label: string;
  wallet: string;
  providerId: IndexedProviderId;
  providerProbe: IndexedProviderProbeResult;
  identity: import("@/lib/walletLedger/onchain/types").OnChainWalletIdentityReport;
  fetchStats: IndexedFetchStats;
  resolutionFetchStats: IndexedFetchStats | null;
  coverage: IndexedWalletCoverageReport;
  reconciliation: import("@/lib/walletLedger/onchain/types").ReconciliationReport;
  apiLedgerMetrics: ReturnType<
    typeof import("@/lib/walletLedger/metrics").computeWalletLedgerMetrics
  > | null;
  indexedLedgerMetrics: ReturnType<
    typeof import("@/lib/walletLedger/metrics").computeWalletLedgerMetrics
  > | null;
  apiOnlyPositions: number;
  indexedPositions: number;
  apiCompletedPositions: number;
  indexedCompletedPositions: number;
  credibilityMetricsValidBefore: boolean;
  credibilityMetricsValidAfter: boolean;
  historyCompleteBefore: boolean;
  historyCompleteAfter: boolean;
  extendsBeforeApiBoundary: boolean;
}

export interface IndexedFeasibilityEstimate {
  wallets: number;
  estimatedRequests: number;
  estimatedDurationMinutes: number;
  estimatedMonthlyCostUsd: number | null;
  notes: string[];
}

export interface IndexedProviderEvaluation {
  providerId: IndexedProviderId;
  probe: IndexedProviderProbeResult;
  sampleFetch?: {
    requests: number;
    elapsedMs: number;
    logsReturned: number;
    pages: number;
  };
}

export type IndexedLedgerEvent = WalletLedgerEvent & {
  source: WalletLedgerEvent["source"] | "indexed_polygon";
};
