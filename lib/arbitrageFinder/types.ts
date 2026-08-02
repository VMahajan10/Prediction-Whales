/**
 * Arbitrage Finder contracts — parallel to, not part of, PipelineTradeEv.
 */

export type ArbVenue = "polymarket" | "kalshi";

export type ArbWindowStrategy = "pm_yes_kalshi_no" | "kalshi_yes_pm_no";

export type ArbRejectReason =
  | "missing_leg"
  | "invalid_price"
  | "sum_gte_threshold"
  | "inverted_mapping"
  | "missing_order_book";

export interface ArbExecutableLeg {
  venue: ArbVenue;
  side: "YES" | "NO";
  contractId: string;
  askPrice: number;
  orderBookTs: number;
  source: "order_book";
}

export interface ArbStakePlan {
  totalStakeUsd: number;
  legStakesUsd: [number, number];
  guaranteedPayoutUsd: number;
  lockedProfitUsd: number;
}

/** Immutable snapshot of a cross-venue sub-100% lock candidate. */
export interface ArbitrageWindow {
  windowId: string;
  mappingPairKey: string;
  polymarketTokenId: string;
  kalshiTicker: string;
  strategy: ArbWindowStrategy;
  legs: [ArbExecutableLeg, ArbExecutableLeg];
  combinedCost: number;
  impliedSumPercent: number;
  inverseOddsSumPercent: number;
  isActionable: boolean;
  profitDeltaPerUnit: number;
  roiPercent: number;
  scannedAt: string;
  maxLegStalenessMs: number;
  orientation: "same" | "inverted";
  matchMethod: string;
  rejectReason?: ArbRejectReason;
  stakePlan?: ArbStakePlan;
}

export interface ArbitrageWindowScanResult {
  windows: ArbitrageWindow[];
  scannedPairs: number;
  actionableCount: number;
  scanDurationMs: number;
}

/** Mapping identity — no pTrue / averageEv fields. */
export interface ArbPairMapping {
  polymarketTokenId: string;
  kalshiTicker: string;
  orientation: "same" | "inverted";
  matchMethod: string;
}

export interface ArbPairOrderBooks {
  pmOb: import("@/lib/evPipeline/redisCache").CachedOrderBookMid | null;
  kalshiOb: import("@/lib/evPipeline/redisCache").CachedOrderBookMid | null;
}

export interface ScanPairInput {
  mapping: ArbPairMapping;
  pmOb: ArbPairOrderBooks["pmOb"];
  kalshiOb: ArbPairOrderBooks["kalshiOb"];
}

export interface WindowScannerOptions {
  maxCombinedCost?: number;
  scannedAt?: string;
  nowMs?: number;
  /** Fetch live PM/Kalshi quotes when Redis order books are missing (default true). */
  liveOrderBookFallback?: boolean;
}
