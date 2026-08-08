/** Normalized trade category stored on feed rows and returned by the categorizer. */
export type TradeCategory =
  | "SPORTS"
  | "POLITICS"
  | "CULTURE"
  | "TRENDING"
  | "OTHER";

/** Alias used by ingestion / DB code. */
export type MarketFeedCategory = TradeCategory;

export const TRADE_CATEGORIES: TradeCategory[] = [
  "SPORTS",
  "POLITICS",
  "CULTURE",
  "TRENDING",
  "OTHER",
];

export const MARKET_FEED_CATEGORIES: MarketFeedCategory[] = TRADE_CATEGORIES;

/** UI whale-feed tab ids (lowercase). */
export type WhaleFeedCategoryTab =
  | "all"
  | "trending"
  | "sports"
  | "politics"
  | "culture";

export type RecentFeedCategoryFilter = WhaleFeedCategoryTab;

export const WHALE_FEED_CATEGORY_TABS: {
  value: WhaleFeedCategoryTab;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "trending", label: "Trending" },
  { value: "sports", label: "Sports" },
  { value: "politics", label: "Politics" },
  { value: "culture", label: "Culture" },
];

export const TRENDING_WINDOW_MS = 10 * 60 * 1000;
export const TRENDING_MIN_STAKE_USD = 1_000;
export const TRENDING_WINDOW_SEC = 10 * 60;

const TAB_TO_TRADE_CATEGORY: Partial<
  Record<WhaleFeedCategoryTab, TradeCategory>
> = {
  sports: "SPORTS",
  politics: "POLITICS",
  culture: "CULTURE",
};

export function normalizeMarketFeedCategory(
  value: string | null | undefined
): MarketFeedCategory | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  if (TRADE_CATEGORIES.includes(upper as TradeCategory)) {
    return upper as TradeCategory;
  }
  return null;
}

export function tradeCategoryForTab(
  tab: WhaleFeedCategoryTab
): TradeCategory | null {
  return TAB_TO_TRADE_CATEGORY[tab] ?? null;
}

export function parseRecentFeedCategoryFilter(
  value: string | null | undefined
): RecentFeedCategoryFilter {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "sports" ||
    normalized === "politics" ||
    normalized === "culture" ||
    normalized === "trending"
  ) {
    return normalized;
  }
  return "all";
}

export function whaleFeedCategoryLabel(tab: WhaleFeedCategoryTab): string {
  return WHALE_FEED_CATEGORY_TABS.find((t) => t.value === tab)?.label ?? tab;
}

export function formatFeedRecency(detectedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - detectedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
}

export function isTrendingByStakeAndRecency(
  usdNotional: number,
  timestampSec: number,
  nowMs = Date.now()
): boolean {
  const ageMs = nowMs - timestampSec * 1000;
  return ageMs <= TRENDING_WINDOW_MS && usdNotional >= TRENDING_MIN_STAKE_USD;
}
