import { inferMarketCategory } from "@/lib/marketCategory";

export type StakeFloorTier = "sports_entertainment" | "macro_political" | "default";

/** Sports and entertainment markets — $250 minimum stake (testing). */
export const STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD = 250;

/** High-liquidity macro / political markets — $1k minimum stake (testing). */
export const STAKE_FLOOR_MACRO_POLITICAL_USD = 1_000;

/** Default fallback stake floor — $500 (testing). */
export const STAKE_FLOOR_DEFAULT_USD = (() => {
  const parsed = Number(process.env.STAKE_FLOOR_DEFAULT_USD);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
})();

const MACRO_LIQUIDITY_PROBE =
  /fed |federal reserve|interest rate|inflation|gdp|recession|unemployment|treasury|cpi |ppi |jobs report|rate cut|rate hike|nonfarm|fomc/i;

const POLITICS_PROBE =
  /congress|trump|election|senate|president|house|federal|fed |governor|primary|democrat|republican/i;

/** Case-insensitive feed category slug (e.g. sports, ESPORTS, gaming). */
export function normalizeFeedCategory(category?: string | null): string {
  return (category ?? "").trim().toLowerCase();
}

const SPORTS_ENTERTAINMENT_CATEGORIES = new Set([
  "sports",
  "culture",
  "entertainment",
  "esports",
  "esport",
  "gaming",
]);

const MACRO_POLITICAL_CATEGORIES = new Set([
  "macro_politics",
  "macro",
  "politics",
  "political",
]);

const GAMING_PROBE = /\bgaming\b|esports?|esport/i;

export interface StakeFloorResolution {
  tier: StakeFloorTier;
  floorUsd: number;
}

function readTierOverrideUsd(
  envKey: string,
  fallback: number
): number {
  const parsed = Number(process.env[envKey]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function classifyStakeFloorTier(
  title: string,
  slug?: string | null,
  eventSlug?: string | null,
  category?: string | null
): StakeFloorTier {
  const probe = `${title} ${slug ?? ""} ${eventSlug ?? ""}`;
  const cat = normalizeFeedCategory(category);

  if (MACRO_POLITICAL_CATEGORIES.has(cat)) {
    return "macro_political";
  }

  if (SPORTS_ENTERTAINMENT_CATEGORIES.has(cat)) {
    return "sports_entertainment";
  }

  // Politics / macro before sports — ESPORTS_PROBE can false-match "presidential" (msi).
  if (POLITICS_PROBE.test(title) || MACRO_LIQUIDITY_PROBE.test(probe)) {
    return "macro_political";
  }

  if (GAMING_PROBE.test(probe)) {
    return "sports_entertainment";
  }

  const inferred = inferMarketCategory(title);

  if (inferred === "SPORTS" || inferred === "CULTURE") {
    return "sports_entertainment";
  }

  return "default";
}

/**
 * Flat post-queue stake floor — aligned with product feed ($500 all categories).
 * Tiered classification remains available via {@link classifyStakeFloorTier} for legacy helpers.
 */
export function resolvePostQueueStakeFloorUsd(
  _title?: string,
  _slug?: string | null,
  _eventSlug?: string | null,
  _category?: string | null
): StakeFloorResolution {
  return {
    tier: "default",
    floorUsd: STAKE_FLOOR_DEFAULT_USD,
  };
}

export function resolveStakeFloorUsd(
  title: string,
  slug?: string | null,
  eventSlug?: string | null,
  category?: string | null
): StakeFloorResolution {
  const tier = classifyStakeFloorTier(title, slug, eventSlug, category);

  switch (tier) {
    case "sports_entertainment":
      return {
        tier,
        floorUsd: readTierOverrideUsd(
          "STAKE_FLOOR_SPORTS_USD",
          STAKE_FLOOR_SPORTS_ENTERTAINMENT_USD
        ),
      };
    case "macro_political":
      return {
        tier,
        floorUsd: readTierOverrideUsd(
          "STAKE_FLOOR_MACRO_USD",
          STAKE_FLOOR_MACRO_POLITICAL_USD
        ),
      };
    default:
      return {
        tier,
        floorUsd: STAKE_FLOOR_DEFAULT_USD,
      };
  }
}

export function formatStakeFloorTierLabel(tier: StakeFloorTier): string {
  switch (tier) {
    case "sports_entertainment":
      return "sports/entertainment";
    case "macro_political":
      return "macro/political";
    default:
      return "default";
  }
}

export function formatStakeFloorSummaryLabel(): string {
  return `$${STAKE_FLOOR_DEFAULT_USD.toLocaleString("en-US")} flat (all categories)`;
}
