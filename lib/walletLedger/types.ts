export type HistoryResolutionMethod =
  | "proxy_wallet_direct"
  | "onchain_receipt_resolved"
  | "data_api_resolved"
  | "funder_resolved"
  | "ambiguous"
  | "unresolved";

export type IdentityConfidence = "high" | "medium" | "low";

export interface IdentityResolutionEvidence {
  transactionHash?: string;
  assetId?: string;
  resolvedFromTxWallet?: string;
  txResolutionSource?: string;
  notes: string[];
}

export interface PolymarketHistoryIdentity {
  requestedWallet: string;
  historyWallet: string | null;
  resolutionMethod: HistoryResolutionMethod;
  confidence: IdentityConfidence;
  candidateWallets: HistoryIdentityCandidate[];
  alternateCandidates: string[];
  evidence: IdentityResolutionEvidence;
  positionsOnlyMismatch: boolean;
  activityCount: number;
  tradeCount: number;
  positionsCount: number;
}

export interface HistoryIdentityCandidate {
  wallet: string;
  source: "requested" | "onchain" | "data_api" | "positions_proxy";
  activityCount: number;
  tradeCount: number;
  positionsCount: number;
  historyScore: number;
}

export interface PaginatedFetchResult<T> {
  rows: T[];
  truncated: boolean;
  pagesFetched: number;
  maxOffsetReached: number;
  pageSize: number;
  error?: string;
}

export interface ActivityApiRow {
  proxyWallet?: string;
  timestamp?: number;
  conditionId?: string;
  type?: string;
  size?: number;
  usdcSize?: number;
  transactionHash?: string;
  price?: number;
  asset?: string;
  side?: string;
  outcomeIndex?: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
}

export interface TradeApiRow {
  proxyWallet?: string;
  side?: "BUY" | "SELL";
  asset?: string;
  conditionId?: string;
  size?: number;
  price?: number;
  timestamp?: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  transactionHash?: string;
}

export interface PositionApiRow {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  size?: number;
  avgPrice?: number;
  initialValue?: number;
  totalBought?: number;
  realizedPnl?: number;
  cashPnl?: number;
  curPrice?: number;
  redeemable?: boolean;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
}

export type WalletLedgerEventType =
  | "BUY"
  | "SELL"
  | "REDEEM"
  | "MERGE"
  | "SPLIT";

export interface WalletLedgerEvent {
  wallet: string;
  conditionId: string;
  asset: string;
  timestamp: number;
  type: WalletLedgerEventType;
  shares?: number;
  cashUsd?: number;
  price?: number;
  txHash?: string;
  source: "activity" | "trades" | "polygon";
  blockNumber?: number;
  /** Block-global log index from chain (authoritative replay order within block). */
  logIndex?: number;
  /** Optional tx index within block when logIndex unavailable. */
  transactionIndex?: number;
  title?: string;
  slug?: string;
  outcome?: string;
  dedupeKey: string;
}

export type PositionAccountingStatus =
  | "ok"
  | "requires_merge_split_resolution"
  | "invalid_capital_accounting"
  | "open";

export type MarketResolutionStatus =
  | "resolved"
  | "open"
  | "unresolved_or_disputed"
  | "missing_metadata";

export type GammaResolutionSource =
  | "condition_id"
  | "slug"
  | "clob_token"
  | "repo_cache"
  | "missing";

export type GammaResolutionConfidence = "high" | "medium" | "low";

export interface GammaMarketResolution {
  conditionId: string;
  marketFound: boolean;
  closed: boolean;
  resolved: boolean;
  resolutionFinal: boolean;
  outcomes: string[];
  outcomePrices: number[];
  winningOutcome: string | null;
  winningAsset: string | null;
  winningIndex: number | null;
  resolvedAt: string | null;
  umaResolutionStatus: string | null;
  resolutionStatus: MarketResolutionStatus;
  question: string | null;
  slug: string | null;
  clobTokenIds: string[];
  source: GammaResolutionSource;
  confidence: GammaResolutionConfidence;
}

export interface PositionLifecycle {
  wallet: string;
  conditionId: string;
  asset: string;
  /** Zero-based episode index within (conditionId, asset) after full-exit splits. */
  lifecycleEpisode: number;
  title: string;
  outcome: string;
  slug: string | null;
  events: WalletLedgerEvent[];
  grossBuyCash: number;
  grossSellCash: number;
  redeemCash: number;
  netShares: number;
  maxCumulativeCashOutlay: number;
  firstEntryAt: number | null;
  lastActivityAt: number | null;
  fullyExited: boolean;
  accountingStatus: PositionAccountingStatus;
  completed: boolean;
  completionReason: "fully_exited" | "held_through_resolution" | null;
  resolution: GammaMarketResolution | null;
  resolutionPayoutUsd: number;
  realizedPnl: number | null;
  capitalAtRisk: number;
  positionRoi: number | null;
  heldThroughResolution: boolean;
  outcomeCorrect: boolean | null;
  excludedFromMetrics: boolean;
  exclusionReason: string | null;
}

export type MetricValidity = "complete" | "partial" | "unusable";

export type HistoryValidity =
  | "complete"
  | "partial-but-metrics-safe"
  | "partial-and-metrics-unsafe"
  | "unusable";

export interface CredibilityMetricBundle {
  completedPositionCount: number;
  resolvedHeldPositionCount: number;
  profitablePositionRate: number | null;
  portfolioRealizedRoi: number | null;
  medianCapitalAtRisk: number;
  meanCapitalAtRisk: number;
  totalCapitalAtRisk: number;
  totalRealizedPnl: number;
  medianPositionRoi: number | null;
  outcomeWinRate: number | null;
  resolvedVolumeUsd: number;
  avgEv: null;
}

export interface ResolutionCoverageReport {
  positionsRequiringResolution: number;
  positionsSuccessfullyResolved: number;
  positionsUnresolved: number;
  resolutionCoveragePct: number;
}

export interface GammaCoverageReport {
  distinctMarkets: number;
  marketsFoundBefore: number;
  marketsFoundAfter: number;
  resolvedBefore: number;
  resolvedAfter: number;
  coverageBeforePct: number;
  coverageAfterPct: number;
  marketFoundCoverageAfterPct: number;
}

export interface MergeSplitReport {
  positionsWithMergeSplit: number;
  pctCompletedPositionsAffected: number;
  grossCashAffected: number;
  potentialCapitalAtRiskAffected: number;
  safeDespiteMergeSplit: number;
  ambiguousMergeSplit: number;
  pctAmbiguousOfCompleted: number;
  recommendation: "exclude_policy_sufficient" | "phase_2c_accounting_required";
}

export interface WalletLedgerMetrics extends CredibilityMetricBundle {
  historyComplete: boolean;
  metricValidity: MetricValidity;
  credibilityMetricsValid: boolean;
  historyValidity: HistoryValidity;
  activityTruncated: boolean;
  tradesTruncated: boolean;
  identityConfidence: IdentityConfidence;
  excludedPositionCount: number;
  historyCompletenessReasons: string[];
  openPositionCount: number;
  distinctPositionCount: number;
  fullyExitedPositionCount: number;
  heldThroughResolutionPositionCount: number;
  rawEventCount: number;
  deduplicatedEventCount: number;
  observedWindowMetrics: CredibilityMetricBundle;
  credibilityMetrics: CredibilityMetricBundle | null;
  resolutionCoverage: ResolutionCoverageReport;
  gammaCoverage: GammaCoverageReport;
  mergeSplit: MergeSplitReport;
}

export interface ProductionWalletMetrics {
  resolvedBetsCount: number;
  avgEv: number;
  winRate: number;
  avgStakeNotional: number;
}

export interface WalletLedgerAuditResult {
  label: string;
  identity: PolymarketHistoryIdentity;
  activity: PaginatedFetchResult<ActivityApiRow>;
  trades: PaginatedFetchResult<TradeApiRow>;
  positionsCount: number;
  gammaResolvedCount: number;
  gammaTotalMarkets: number;
  positions: PositionLifecycle[];
  metrics: WalletLedgerMetrics;
  production: ProductionWalletMetrics | null;
  reconciliation: {
    rawEvents: number;
    deduplicatedEvents: number;
    distinctPositions: number;
    completedPositions: number;
    openPositions: number;
    excludedPositions: number;
    fullyExitedPositions: number;
    heldThroughResolutionPositions: number;
    winningHeldPositions: number;
    losingHeldPositions: number;
    unresolvedHeldPositions: number;
  };
}
