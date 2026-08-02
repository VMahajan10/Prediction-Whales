import {
  resolveStakeFloorUsd,
  STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD,
} from "@/lib/x-agent/stakeFloor";

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

/** Minimum trade-level EV for qualified feed display (+3.0%). */
export const MIN_FEED_TRADE_EV_PCT = 3;

/** Minimum trade-level EV as decimal (0.03). */
export const MIN_FEED_TRADE_EV_DECIMAL = MIN_FEED_TRADE_EV_PCT / 100;

/** Lowest tiered stake floor — used to pre-filter candidates before wallet/EV checks. */
export const MIN_FEED_STAKE_PREFILTER_USD = STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD;

/** Minimum USD stake for qualified whale feed trades. */
export const MIN_STAKE_THRESHOLD = CREDIBILITY_CONFIG.MIN_STAKE_USD;

/** Minimum wallet historical avg EV for qualified feed (+1.0%). */
export const MIN_AVG_EV_THRESHOLD = CREDIBILITY_CONFIG.MIN_AVG_EV;

/** Minimum resolved bets for wallet credibility in qualified feeds. */
export const MIN_FEED_RESOLVED_BETS = CREDIBILITY_CONFIG.MIN_RESOLVED_BETS;

export function meetsFeedStakeThreshold(stakeUsd: number): boolean {
  return Number.isFinite(stakeUsd) && stakeUsd >= CREDIBILITY_CONFIG.MIN_STAKE_USD;
}

export function meetsFeedTieredStakeThreshold(input: {
  stakeUsd: number;
  title?: string | null;
  slug?: string | null;
  eventSlug?: string | null;
  category?: string | null;
}): boolean {
  if (!Number.isFinite(input.stakeUsd)) return false;
  const { floorUsd } = resolveStakeFloorUsd(
    input.title ?? "",
    input.slug,
    input.eventSlug,
    input.category
  );
  return input.stakeUsd >= floorUsd;
}

export function meetsFeedTradeEvThreshold(
  tradeEvPercent: number | null | undefined
): boolean {
  return (
    tradeEvPercent != null &&
    Number.isFinite(tradeEvPercent) &&
    tradeEvPercent >= MIN_FEED_TRADE_EV_PCT
  );
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
  title?: string | null;
  slug?: string | null;
  eventSlug?: string | null;
  category?: string | null;
  /** Trade-level EV % at entry — required for feed display (+3.0% min). */
  tradeEvPercent?: number | null;
}

/**
 * Credibility gate for product feed trades — all criteria required:
 * tiered stake floor, wallet avg EV >= +1.0%, resolved bets >= 100,
 * trade EV >= +3.0%.
 */
export function isQualifiedFeedTrade(trade: FeedQualificationTrade): boolean {
  const resolvedBetCount = trade.resolvedBetCount ?? trade.resolvedBetsCount;

  return (
    meetsFeedTieredStakeThreshold({
      stakeUsd: trade.stakeUsd,
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
      category: trade.category,
    }) &&
    meetsWalletAvgEvThreshold(trade.walletAvgEv) &&
    meetsFeedResolvedBetsThreshold(resolvedBetCount) &&
    meetsFeedTradeEvThreshold(trade.tradeEvPercent)
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
