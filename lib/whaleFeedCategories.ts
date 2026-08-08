import { inferMarketCategory, type MarketCategory } from "@/lib/marketCategory";
import { categorizeMarketByRegex } from "@/lib/categorizerRegex";
import {
  TRENDING_MIN_STAKE_USD,
  TRENDING_WINDOW_MS,
  normalizeMarketFeedCategory,
  tradeCategoryForTab,
  whaleFeedCategoryLabel,
  WHALE_FEED_CATEGORY_TABS,
  type WhaleFeedCategoryTab,
} from "@/lib/constants/categories";
import type { WhaleTrade } from "@/lib/whaleTrades";

export {
  formatFeedRecency,
  whaleFeedCategoryLabel,
  WHALE_FEED_CATEGORY_TABS,
  type WhaleFeedCategoryTab,
} from "@/lib/constants/categories";

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

  const expected = tradeCategoryForTab(tab);
  if (!expected) return true;
  return resolveTradeMarketCategory(trade) === expected;
}
