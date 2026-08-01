/**
 * Shared credibility thresholds for product feed and X-agent post queue.
 * MIN_RESOLVED_BETS matches the current Polymarket closed-positions API capture
 * ceiling — wallets below this lack enough resolved history for reliable scoring.
 */
export const CREDIBILITY_CONFIG = {
  MIN_RESOLVED_BETS: 100,
  MIN_STAKE_USD: 250,
  MIN_AVG_EV: 0.01,
} as const;

/** Minimum USD stake for qualified whale feed trades. */
export const MIN_STAKE_THRESHOLD = CREDIBILITY_CONFIG.MIN_STAKE_USD;

/** Minimum wallet historical avg EV for qualified feed (+1.0%). */
export const MIN_AVG_EV_THRESHOLD = CREDIBILITY_CONFIG.MIN_AVG_EV;

/** Minimum resolved bets for wallet credibility in qualified feeds. */
export const MIN_FEED_RESOLVED_BETS = CREDIBILITY_CONFIG.MIN_RESOLVED_BETS;

export function meetsFeedStakeThreshold(stakeUsd: number): boolean {
  return Number.isFinite(stakeUsd) && stakeUsd >= CREDIBILITY_CONFIG.MIN_STAKE_USD;
}

export function meetsWalletAvgEvThreshold(
  avgEv: number | null | undefined
): boolean {
  return (
    avgEv != null &&
    Number.isFinite(avgEv) &&
    avgEv >= CREDIBILITY_CONFIG.MIN_AVG_EV
  );
}

export function meetsFeedResolvedBetsThreshold(
  resolvedCount: number | null | undefined
): boolean {
  return (
    resolvedCount != null &&
    Number.isFinite(resolvedCount) &&
    resolvedCount >= CREDIBILITY_CONFIG.MIN_RESOLVED_BETS
  );
}

export interface FeedQualificationTrade {
  stakeUsd: number;
  walletAvgEv?: number | null;
  resolvedBetCount?: number | null;
  /** @deprecated Use resolvedBetCount */
  resolvedBetsCount?: number | null;
}

/**
 * Credibility gate for product feed trades — all criteria required:
 * stake >= $250, wallet avg EV >= +1.0%, resolved bets >= 100.
 */
export function isQualifiedFeedTrade(trade: FeedQualificationTrade): boolean {
  const resolvedBetCount = trade.resolvedBetCount ?? trade.resolvedBetsCount;

  return (
    meetsFeedStakeThreshold(trade.stakeUsd) &&
    meetsWalletAvgEvThreshold(trade.walletAvgEv) &&
    meetsFeedResolvedBetsThreshold(resolvedBetCount)
  );
}

export interface WalletFeedQualificationInput {
  avgEv: number | null | undefined;
  resolvedBetCount?: number | null;
  /** @deprecated Use resolvedBetCount */
  resolvedBetsCount?: number | null;
}

export function isQualifiedWalletForFeed(
  input: WalletFeedQualificationInput
): boolean {
  const resolvedBetCount = input.resolvedBetCount ?? input.resolvedBetsCount;

  return (
    meetsFeedResolvedBetsThreshold(resolvedBetCount) &&
    meetsWalletAvgEvThreshold(input.avgEv)
  );
}
