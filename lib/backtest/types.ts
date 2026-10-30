import type { ClosingLineExclusionReason } from "@/lib/clvPriceHistory";
import type { ClosingPriceExclusionReason } from "@/lib/backtest/closingPrice";

export type BacktestFillSide = "BUY" | "SELL";

export interface BacktestFill {
  walletAddress: string;
  conditionId: string;
  assetId: string;
  side: BacktestFillSide;
  price: number;
  sizeUsd: number;
  shares: number;
  /** Unix seconds. */
  timestamp: number;
  marketTitle?: string | null;
  outcome?: string | null;
  eventSlug?: string | null;
  marketSlug?: string | null;
}

export interface MarketResolution {
  conditionId: string;
  marketTitle?: string | null;
  /** Per CLOB token id → outcome label (Yes/No/team name). */
  outcomeByTokenId?: Record<string, string>;
  winningAsset: string | null;
  /** Unix seconds; null when unknown. */
  resolvedAt: number | null;
  resolutionStatus:
    | "resolved"
    | "open"
    | "unresolved_or_disputed"
    | "missing_metadata";
  resolutionFinal: boolean;
}

export type TradeExclusionReason =
  | ClosingLineExclusionReason
  | ClosingPriceExclusionReason
  | "unresolved_market"
  | "disputed_market"
  | "post_resolution_fill"
  | "unresolved_at_window_end"
  | "pre_close"
  | "missing_condition"
  | "missing_asset"
  | "invalid_entry"
  | "missing_closing_price"
  | "after_closing_cutoff";

export interface TradeClvRecord extends BacktestFill {
  marketId: string;
  marketTitle: string | null;
  outcome: string | null;
  tokenId: string;
  closingLinePrice: number | null;
  /** Unix seconds of the closing price observation. */
  closeTimestamp: number | null;
  /** CLV in cents: (close − entry) × 100, rounded to 1 decimal. */
  clvCents: number | null;
  isValidClv: boolean;
  exclusionReason?: TradeExclusionReason;
  /** False when market resolved after rankEnd under ranking mode. */
  rankingEligible: boolean;
  heldAssetSettled?: 0 | 1;
  closingLineSource?: "tape" | "clob" | null;
  closingCutoffUnix?: number | null;
}

export type ClvResolutionMode = "ranking" | "final";

export interface BacktestWindowConfig {
  rankStart: string;
  rankEnd: string;
  minTradesPerWallet: number;
  preCloseMinutes: number;
  /**
   * `ranking` — exclude fills whose market resolved after rankEnd (no lookahead).
   * `final` — use actual resolution time for CLV materialization / QA.
   */
  clvResolutionMode: ClvResolutionMode;
  fillSource: "data-api" | "ledger";
  preTradingEndHours: number;
  vwapTradeCount: number;
  minTapeTrades: number;
}

export interface ClosingLineCacheEntry {
  schemaVersion: 3;
  assetId: string;
  closingCutoffUnix: number;
  vwapTradeCount: number;
  closingLine: number | null;
  pricePointTimestamp: number | null;
  valid: boolean;
  reason?: string;
  historySource?: "tape" | "clob" | string | null;
}

export interface ClvPanelExport {
  config: BacktestWindowConfig;
  generatedAt: string;
  stats: ClvPanelStats;
  walletFunnel: WalletFunnelRow[];
  records: TradeClvRecord[];
}

export interface ClvPanelStats {
  hydratedWalletCount: number;
  walletsWithAnyLedgerBuyInWindow: number;
  /** All BUY rows in window (including rows missing condition/asset). */
  ledgerBuyRowsInWindow: number;
  /** BUY rows with condition_id, asset_id, and timestamp (extract query). */
  ledgerBuyRowsExtractable: number;
  fillsExtracted: number;
  fillsAfterMarketFilters: number;
  validClvFills: number;
  preCloseExcluded: number;
  unresolvedMarketExcluded: number;
  postResolutionExcluded: number;
  unresolvedAtWindowEndExcluded: number;
  missingClosingPrice: number;
  /** Share of valid CLV rows with closing price below 0.05 or above 0.95. */
  closingLineLeakageShare: number;
  fillSource: "data-api" | "ledger";
  dataApiExtractableRate: number | null;
}

export interface WalletFunnelRow {
  walletAddress: string;
  ledgerBuyRowsInWindow: number;
  ledgerBuyRowsExtractable: number;
  parsedFills: number;
  afterMarketFilters: number;
  validClv: number;
  topExclusionReason: string | null;
}

export interface WalletClvRankingRow {
  walletAddress: string;
  qualifyingTrades: number;
  validClvTrades: number;
  unweightedClvCents: number | null;
  weightedClvCents: number | null;
}
