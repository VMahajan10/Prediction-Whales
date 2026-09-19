import type { CredibilityResult } from "@/lib/walletLedger/indexed/indexedCredibility";
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
  /** @deprecated Reporting-only blended min(activity, trades). */
  apiOldestTimestamp: number | null;
  apiNewestTimestamp: number | null;
  oldestActivityTimestamp: number | null;
  oldestTradesTimestamp: number | null;
  indexedOldestTimestamp: number | null;
  indexedNewestTimestamp: number | null;
  apiEventCount: number;
  indexedEventCount: number;
  /** @deprecated Use eventsBeforeActivityBoundary / eventsBeforeTradesBoundary. */
  eventsBeforeApiBoundary: number;
  eventsBeforeActivityBoundary: number;
  eventsBeforeTradesBoundary: number;
  activityTruncationImmune: boolean;
  tradesTruncationImmune: boolean;
  additionalCompletedPositions: number;
  scanFromBlock: number;
  scanToBlock: number;
  adaptiveFromBlockReason?: string;
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
  /** Canonical API-reconstructed credibility (B). */
  apiCredibility?: CredibilityResult | null;
  /** Canonical indexed credibility (C). */
  indexedCredibility?: CredibilityResult;
  historyCompleteBefore: boolean;
  historyCompleteAfter: boolean;
  historyCompletenessBreakdown?: Record<string, boolean>;
  blockTimestampStats?: import("@/lib/walletLedger/indexed/blockTimestampCache").BlockTimestampCacheStats;
  gammaPrefetchStats?: import("@/lib/walletLedger/gamma").GammaPrefetchStats;
  extendsBeforeApiBoundary: boolean;
  /** Max of run + persisted pre-API event counts. */
  eventsBeforeApiBoundaryEffective?: number;
  sourceTruncationImmunity?: import("@/lib/walletLedger/indexed/sourceTruncationImmunity").SourceTruncationImmunityResult;
  verifiedTradeTxEvidence?: import("@/lib/walletLedger/indexed/adaptiveStartBlock").VerifiedTradeTxEvidence[];
  adaptiveFromBlock?: import("@/lib/walletLedger/indexed/adaptiveStartBlock").AdaptiveFromBlockResult;
  indexedEvents?: import("@/lib/walletLedger/types").WalletLedgerEvent[];
  /** DB persisted + delta chain events used for credibility reconstruction. */
  authoritativeIndexedEvents?: import("@/lib/walletLedger/types").WalletLedgerEvent[];
  authoritativeEventStats?: import("@/lib/walletLedger/indexed/authoritativeEvents").AuthoritativeEventMergeStats;
  historicalBackfillRequired?: boolean;
  indexedLifecyclePositions?: import("@/lib/walletLedger/types").PositionLifecycle[];
  /** Normalized deduplicated API events used for indexed metric computation. */
  apiEvents?: import("@/lib/walletLedger/types").WalletLedgerEvent[];
  gammaCacheEntries?: Array<
    [string, import("@/lib/walletLedger/types").GammaMarketResolution]
  >;
  throughBlock?: number;
  scanFromBlock?: number;
  debugReport?: IndexedWalletDebugReport;
  stageTimingsMs?: Record<string, number>;
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
  probeAttempts?: number;
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

export interface IndexedWalletDebugReport {
  queryPlan: import("@/lib/walletLedger/indexed/queryPlan").EtherscanQueryPlanReport;
  scanSubjects: string[];
  blockWindow: { fromBlock: number; toBlock: number; fullHistory: boolean };
  funnelBySubject: Record<
    string,
    import("@/lib/walletLedger/indexed/funnel").IndexedEventFunnel
  >;
  apiTxHashes: string[];
  indexedTxHashes: string[];
  overlappingTxHashes: string[];
  orderFilledTopicLayout: typeof import("@/lib/walletLedger/indexed/queryPlan").ORDER_FILLED_TOPIC_LAYOUT;
  walletTopicEncoding: string;
}
