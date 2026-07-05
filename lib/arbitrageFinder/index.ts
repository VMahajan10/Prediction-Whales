export type {
  ArbExecutableLeg,
  ArbPairMapping,
  ArbPairOrderBooks,
  ArbRejectReason,
  ArbStakePlan,
  ArbVenue,
  ArbWindowStrategy,
  ArbitrageWindow,
  ArbitrageWindowScanResult,
  ScanPairInput,
  WindowScannerOptions,
} from "@/lib/arbitrageFinder/types";

export {
  fetchKalshiOrderBookMid,
  fetchPairOrderBooks,
  fetchPmOrderBookMid,
  maxOrderBookStalenessMs,
} from "@/lib/arbitrageFinder/adapters/orderBookAdapter";

export {
  prefetchArbPairMappings,
  resolveMappingByKalshiTicker,
  resolveMappingByPmToken,
  resolveMappingForPair,
  toArbPairMapping,
} from "@/lib/arbitrageFinder/adapters/mappingAdapter";

export {
  countActiveArbPairMappings,
  loadActiveArbPairMappings,
} from "@/lib/arbitrageFinder/adapters/pairCatalogAdapter";

export {
  pickBestActionableWindow,
  scanArbitrageWindowForPair,
  scanArbitrageWindows,
  scanArbitrageWindowsForPair,
} from "@/lib/arbitrageFinder/windowScanner";

export {
  computeRoiPercent,
  DEFAULT_MAX_COMBINED_COST,
  DEFAULT_MAX_IMPLIED_SUM_PERCENT,
  evaluateBinaryBoxArbitrage,
  evaluateDirectionalWindows,
  formatInverseOddsSumPercent,
} from "@/lib/finance/arbitrageEngine";

export {
  applyVenueStakeConstraints,
  optimizeEqualPayoutStakeSplit,
  type StakeSplitInput,
  type StakeSplitResult,
  type VenueStakeConstraints,
} from "@/lib/finance/arbitrageStakeMath";

export {
  attachStakePlan,
  attachStakePlans,
  attachStakeToBestWindow,
  buildStakePlan,
  type AttachStakePlanOptions,
} from "@/lib/arbitrageFinder/stakeOptimizer";

export {
  getCachedArbWindows,
  setCachedArbWindows,
  getArbScanMeta,
  setArbScanMeta,
  arbRedisKeys,
  ARB_WINDOW_CACHE_TTL_SEC,
  ARB_SCAN_META_TTL_SEC,
  type ArbScanMetaPayload,
} from "@/lib/arbitrageFinder/cache/windowCache";

export {
  getArbitrageWindowsForPair,
  parseStakeUsd,
  resolvePairIdentifiers,
  scanArbitrageWindowsBatch,
  scanArbitrageWindowsWithStake,
  type ArbitrageWindowPairResult,
  type BatchPairScanItem,
  type WindowServiceOptions,
} from "@/lib/arbitrageFinder/windowService";

export {
  filterActionableWindows,
  formatArbLockLabel,
  formatArbPairLabel,
  sortArbitrageWindowsByRoi,
  topArbitrageWindows,
} from "@/lib/arbitrageFinder/feedUtils";

export { resolveArbIdentifiersForWhaleTrade } from "@/lib/arbitrageFinder/resolveWhaleArbIdentifiers";

export {
  normalizeTradeOutcomeSide,
} from "@/lib/arbitrageFinder/displayUtils";

export type {
  ArbDisplayMode,
  ArbitrageDisplayLeg,
  ArbitrageDisplaySnapshot,
  QuoteSource,
  ResolveArbitrageDisplayInput,
} from "@/lib/arbitrageFinder/displayTypes";

export { resolveArbitrageDisplay } from "@/lib/arbitrageFinder/displayResolver";

export {
  resolveExchangeProxyQuotes,
  resolveVenueYesNoQuotes,
  singleVenueLegs,
  type ResolvedYesNoQuotes,
} from "@/lib/arbitrageFinder/quoteFallbackLadder";

export {
  ARB_ORDER_BOOK_STALE_MS,
  aggregateScanCoverage,
  collectArbitrageScanCoverage,
  diagnosePairScan,
  formatArbitrageScanCoverageSummary,
  getLatestArbitrageScanCoverage,
  recordArbitrageScanCoverage,
  type ArbPairScanDiagnostic,
  type ArbitrageScanCoverageReport,
  type CollectArbitrageScanCoverageOptions,
} from "@/lib/arbitrageFinder/observability/scanCoverage";

export {
  deriveYesNoAsksFromOrderBook,
  type OrderBookQuoteSnapshot,
  type YesNoAsks,
} from "@/lib/finance/orderBookQuotes";
