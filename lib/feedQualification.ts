/** Minimum USD stake for qualified whale feed trades. */
export const MIN_STAKE_THRESHOLD = 500;

/** Minimum wallet historical avg EV for qualified feed (+3.0%). */
export const MIN_AVG_EV_THRESHOLD = 0.03;

/** Minimum resolved bets for wallet credibility in qualified feeds. */
export const MIN_FEED_RESOLVED_BETS = 300;

export function meetsFeedStakeThreshold(stakeUsd: number): boolean {
  return Number.isFinite(stakeUsd) && stakeUsd >= MIN_STAKE_THRESHOLD;
}

export function meetsWalletAvgEvThreshold(
  avgEv: number | null | undefined
): boolean {
  return (
    avgEv != null && Number.isFinite(avgEv) && avgEv >= MIN_AVG_EV_THRESHOLD
  );
}

export function meetsFeedResolvedBetsThreshold(
  resolvedCount: number | null | undefined
): boolean {
  return (
    resolvedCount != null &&
    Number.isFinite(resolvedCount) &&
    resolvedCount >= MIN_FEED_RESOLVED_BETS
  );
}

export interface FeedQualificationInput {
  stakeUsd: number;
  walletAvgEv?: number | null;
  resolvedBetsCount?: number | null;
}

/** Pure feed qualification — no I/O; caller supplies wallet stats when known. */
export function isQualifiedFeedTrade(input: FeedQualificationInput): boolean {
  if (!meetsFeedStakeThreshold(input.stakeUsd)) return false;

  if (
    input.resolvedBetsCount != null &&
    !meetsFeedResolvedBetsThreshold(input.resolvedBetsCount)
  ) {
    return false;
  }

  if (input.walletAvgEv != null && !meetsWalletAvgEvThreshold(input.walletAvgEv)) {
    return false;
  }

  return true;
}

export interface WalletFeedQualificationInput {
  avgEv: number | null | undefined;
  resolvedBetsCount: number | null | undefined;
}

export function isQualifiedWalletForFeed(
  input: WalletFeedQualificationInput
): boolean {
  return (
    meetsFeedResolvedBetsThreshold(input.resolvedBetsCount) &&
    meetsWalletAvgEvThreshold(input.avgEv)
  );
}
