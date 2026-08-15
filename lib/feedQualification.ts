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

/** Minimum stake to ingest/cache raw live socket trades (worker + browser). */
export const MIN_RAW_INGESTION_STAKE_USD = 10;

/** Flat minimum stake for the product feed UI — not the X post queue tiered floors. */
export const MIN_PRODUCT_FEED_STAKE_USD = 500;

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

/** Minimum resolved bets for wallet credibility in qualified feeds (X-agent / legacy). */
export const MIN_FEED_RESOLVED_BETS = CREDIBILITY_CONFIG.MIN_RESOLVED_BETS;

/** Product feed trader credibility — minimum resolved bet count. */
export const MIN_PRODUCT_FEED_RESOLVED_BETS = 10;

/** Product feed trader credibility — minimum total resolved stake volume (USD). */
export const MIN_PRODUCT_FEED_RESOLVED_VOLUME_USD = 300;

export function meetsProductFeedResolvedBetsThreshold(
  resolvedCount: number | null | undefined
): boolean {
  return (
    resolvedCount != null &&
    Number.isFinite(resolvedCount) &&
    resolvedCount >= MIN_PRODUCT_FEED_RESOLVED_BETS
  );
}

export function meetsProductFeedResolvedVolumeThreshold(
  volumeUsd: number | null | undefined
): boolean {
  return (
    volumeUsd != null &&
    Number.isFinite(volumeUsd) &&
    volumeUsd >= MIN_PRODUCT_FEED_RESOLVED_VOLUME_USD
  );
}

export interface ProductFeedTraderStats {
  resolvedBetCount?: number | null;
  /** @deprecated Use resolvedBetCount */
  resolvedBetsCount?: number | null;
  avgStakeNotional?: number | null;
  resolvedVolumeUSD?: number | null;
}

/** Estimate resolved volume from registry stats when explicit volume is absent. */
export function resolveTraderResolvedVolumeUsd(
  stats: ProductFeedTraderStats
): number {
  if (
    stats.resolvedVolumeUSD != null &&
    Number.isFinite(stats.resolvedVolumeUSD)
  ) {
    return stats.resolvedVolumeUSD;
  }

  const count =
    stats.resolvedBetCount ?? stats.resolvedBetsCount ?? null;
  const avgStake = stats.avgStakeNotional ?? null;
  if (
    count != null &&
    Number.isFinite(count) &&
    count > 0 &&
    avgStake != null &&
    Number.isFinite(avgStake) &&
    avgStake > 0
  ) {
    return count * avgStake;
  }

  return 0;
}

/** Product feed trader gate — resolved bet count + resolved volume only (no wallet avg EV). */
export function isQualifiedTraderForProductFeed(
  stats: ProductFeedTraderStats
): boolean {
  const resolvedBetCount =
    stats.resolvedBetCount ?? stats.resolvedBetsCount ?? null;
  const volumeUsd = resolveTraderResolvedVolumeUsd(stats);
  return (
    meetsProductFeedResolvedBetsThreshold(resolvedBetCount) &&
    meetsProductFeedResolvedVolumeThreshold(volumeUsd)
  );
}

/**
 * Trader history not yet indexed — registry row missing or volume/count still null.
 * Distinct from wallets with calculated metrics that fail thresholds (e.g. 0 bets).
 */
export function isTraderMetricsUncalculated(
  stats: ProductFeedTraderStats & { avgEv?: number | null }
): boolean {
  const count = stats.resolvedBetCount ?? stats.resolvedBetsCount;
  if (count == null) return true;
  if (
    stats.resolvedVolumeUSD == null &&
    stats.avgStakeNotional == null
  ) {
    return true;
  }
  return false;
}

/**
 * Polymarket feed trader gate — strict when metrics exist; fallback while backfilling.
 * Call with `tradePassesProductFeedGates=true` only after stake + EV gates pass.
 */
export function passesPolymarketTraderCredibilityForFeed(
  stats: WalletFeedQualificationInput,
  tradePassesProductFeedGates = true
): boolean {
  if (isQualifiedTraderForProductFeed(stats)) return true;
  if (!tradePassesProductFeedGates) return false;
  return isTraderMetricsUncalculated(stats);
}

export function meetsFeedStakeThreshold(stakeUsd: number): boolean {
  return Number.isFinite(stakeUsd) && stakeUsd >= CREDIBILITY_CONFIG.MIN_STAKE_USD;
}

/** Raw ingestion gate — low floor so trades can be cached before product-feed filtering. */
export function meetsRawIngestionStakeThreshold(stakeUsd: number): boolean {
  return (
    Number.isFinite(stakeUsd) && stakeUsd >= MIN_RAW_INGESTION_STAKE_USD
  );
}

/** Product feed gate — flat $500 notional minimum (all categories). */
export function meetsProductFeedStakeThreshold(stakeUsd: number): boolean {
  return (
    Number.isFinite(stakeUsd) && stakeUsd >= MIN_PRODUCT_FEED_STAKE_USD
  );
}

export function formatProductFeedStakeLabel(): string {
  return `$${MIN_PRODUCT_FEED_STAKE_USD.toLocaleString("en-US")} min stake`;
}

/**
 * Category-tiered stake floors — used by the X post queue and legacy credentialed
 * helpers only. The product feed uses {@link meetsProductFeedStakeThreshold}.
 */
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

/** Strict product-feed EV floor in decimal probability units (0.03 = +3.0%). */
export function meetsFeedTradeEvDecimal(
  evDecimal: number | null | undefined
): boolean {
  return (
    evDecimal != null &&
    Number.isFinite(evDecimal) &&
    evDecimal >= MIN_FEED_TRADE_EV_DECIMAL
  );
}

/** Trade-level EV in percent or decimal — rejects N/A and values below +3.0%. */
export function passesStrictFeedTradeEv(input: {
  netEvPercent?: number | null;
  ev?: number | null;
}): boolean {
  if (meetsFeedTradeEvThreshold(input.netEvPercent)) return true;
  return meetsFeedTradeEvDecimal(input.ev);
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

export type LiveFeedQualificationTrade = Pick<
  FeedQualificationTrade,
  | "stakeUsd"
  | "title"
  | "slug"
  | "eventSlug"
  | "category"
  | "tradeEvPercent"
>;

/** USD notional for Polymarket REST trades (shares × price, or shares × price_cents / 100). */
export function resolvePolymarketTradeNotionalUsd(trade: {
  price: number;
  size: number;
}): number {
  const { price, size } = trade;
  if (!Number.isFinite(size) || size <= 0) return 0;
  if (!Number.isFinite(price) || price <= 0) return 0;

  // Decimal contract price (0–1): shares × price
  if (price <= 1) {
    const notional = price * size;
    return Number.isFinite(notional) && notional > 0 ? notional : 0;
  }

  // Cents-style (1–100): shares × price_cents / 100
  if (price <= 100) {
    const notional = (price / 100) * size;
    return Number.isFinite(notional) && notional > 0 ? notional : 0;
  }

  return 0;
}

/** Product feed stake floor — flat $500 regardless of market category. */
export function resolveLiveFeedStakeFloorUsd(
  _trade?: Pick<
    LiveFeedQualificationTrade,
    "title" | "slug" | "eventSlug" | "category"
  >
): number {
  return MIN_PRODUCT_FEED_STAKE_USD;
}

/**
 * Product feed gate — flat $500 stake + trade EV >= +3.0%.
 * Does NOT apply X post queue tiered floors or wallet credibility checks.
 */
export function isQualifiedLiveFeedTrade(
  trade: LiveFeedQualificationTrade
): boolean {
  return (
    meetsProductFeedStakeThreshold(trade.stakeUsd) &&
    meetsFeedTradeEvThreshold(trade.tradeEvPercent)
  );
}

/**
 * Legacy credentialed gate — tiered stake (X post queue style) plus wallet history.
 * @deprecated For the product feed use {@link isQualifiedLiveFeedTrade}.
 */
export function isQualifiedCredentialedFeedTrade(
  trade: FeedQualificationTrade
): boolean {
  const resolvedBetCount = trade.resolvedBetCount ?? trade.resolvedBetsCount;

  return (
    meetsFeedTieredStakeThreshold({
      stakeUsd: trade.stakeUsd,
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
      category: trade.category,
    }) &&
    meetsFeedTradeEvThreshold(trade.tradeEvPercent) &&
    meetsWalletAvgEvThreshold(trade.walletAvgEv) &&
    meetsFeedResolvedBetsThreshold(resolvedBetCount)
  );
}

/** @alias isQualifiedCredentialedFeedTrade — prefer isQualifiedLiveFeedTrade for web feed. */
export function isQualifiedFeedTrade(trade: FeedQualificationTrade): boolean {
  return isQualifiedCredentialedFeedTrade(trade);
}

export interface WalletFeedQualificationInput {
  avgEv?: number | null;
  resolvedBetCount?: number | null;
  /** @deprecated Use resolvedBetCount */
  resolvedBetsCount?: number | null;
  avgStakeNotional?: number | null;
  resolvedVolumeUSD?: number | null;
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

/** Product feed wallet gate — 10+ resolved bets and $300+ resolved volume. */
export function isQualifiedWalletForProductFeed(
  input: WalletFeedQualificationInput
): boolean {
  return isQualifiedTraderForProductFeed(input);
}
