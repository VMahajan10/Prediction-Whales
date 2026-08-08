import { inferMarketCategory, type MarketCategory } from "@/lib/marketCategory";
import {
  categorizeMarketByRegex,
  normalizeMarketFeedCategory,
} from "@/lib/categorizer";
import type { WhaleTrade } from "@/lib/whaleTrades";

export type WhaleFeedCategoryTab =
  | "all"
  | "trending"
  | "sports"
  | "politics"
  | "culture";

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

const TAB_TO_CATEGORY: Partial<Record<WhaleFeedCategoryTab, MarketCategory>> = {
  sports: "SPORTS",
  politics: "POLITICS",
  culture: "CULTURE",
};

const TRENDING_WINDOW_MS = 10 * 60 * 1000;
const TRENDING_MIN_STAKE_USD = 1_000;

export function isTrendingWhaleTrade(
  trade: WhaleTrade,
  now = Date.now()
): boolean {
  const ageMs = now - trade.detectedAt;
  return ageMs <= TRENDING_WINDOW_MS && trade.usdNotional >= TRENDING_MIN_STAKE_USD;
}

function resolveTradeMarketCategory(trade: WhaleTrade): MarketCategory {
  const stored = normalizeMarketFeedCategory(trade.category);
  if (stored === "SPORTS") return "SPORTS";
  if (stored === "POLITICS") return "POLITICS";
  if (stored === "CULTURE") return "CULTURE";

  const regexHit = categorizeMarketByRegex(
    trade.title,
    trade.slug ?? trade.eventSlug ?? trade.ticker
  );
  if (regexHit === "SPORTS") return "SPORTS";
  if (regexHit === "POLITICS") return "POLITICS";
  if (regexHit === "CULTURE") return "CULTURE";

  return inferMarketCategory(trade.title);
}

export function matchesWhaleFeedCategory(
  trade: WhaleTrade,
  tab: WhaleFeedCategoryTab,
  now = Date.now()
): boolean {
  if (tab === "all") return true;
  if (tab === "trending") return isTrendingWhaleTrade(trade, now);

  const expected = TAB_TO_CATEGORY[tab];
  if (!expected) return true;
  return resolveTradeMarketCategory(trade) === expected;
}

export function formatFeedRecency(detectedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - detectedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h`;
}

export function whaleFeedCategoryLabel(tab: WhaleFeedCategoryTab): string {
  return WHALE_FEED_CATEGORY_TABS.find((t) => t.value === tab)?.label ?? tab;
}
