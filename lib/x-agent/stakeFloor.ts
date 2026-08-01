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
  eventSlug?: string | null
): StakeFloorTier {
  const probe = `${title} ${slug ?? ""} ${eventSlug ?? ""}`;

  // Politics / macro before sports — ESPORTS_PROBE can false-match "presidential" (msi).
  if (POLITICS_PROBE.test(title) || MACRO_LIQUIDITY_PROBE.test(probe)) {
    return "macro_political";
  }

  const category = inferMarketCategory(title);

  if (category === "SPORTS" || category === "CULTURE") {
    return "sports_entertainment";
  }

  return "default";
}

export function resolveStakeFloorUsd(
  title: string,
  slug?: string | null,
  eventSlug?: string | null
): StakeFloorResolution {
  const tier = classifyStakeFloorTier(title, slug, eventSlug);

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
  return "tiered ($250 sports/culture · $500 default · $1k macro/politics)";
}
