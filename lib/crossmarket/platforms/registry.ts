import { fetchKalshiRawMarkets } from "./kalshi";
import { fetchManifoldRawMarkets } from "./manifold";
import { fetchMetaculusRawMarkets } from "./metaculus";
import type {
  NormalizedMarket,
  PlatformId,
  PlatformRegistryEntry,
  RawMarket,
  Tier,
  Tier1PlatformId,
} from "./types";

export const PLATFORM_REGISTRY: Record<Tier1PlatformId, PlatformRegistryEntry> = {
  kalshi: {
    id: "kalshi",
    tier: 1,
    reliability: 0.92,
    fetch: fetchKalshiRawMarkets,
    priceNote: "YES bid/ask midpoint (tradeable exchange quote)",
  },
  manifold: {
    id: "manifold",
    tier: 1,
    reliability: 0.78,
    fetch: fetchManifoldRawMarkets,
    priceNote: "CPMM `probability` on BINARY markets (play-money AMM)",
  },
  metaculus: {
    id: "metaculus",
    tier: 1,
    reliability: 0.72,
    fetch: fetchMetaculusRawMarkets,
    priceNote:
      "Community median forecast (community_prediction.full.q2) — NOT tradeable",
  },
};

export const TIER1_PLATFORM_IDS = Object.keys(
  PLATFORM_REGISTRY
) as Tier1PlatformId[];

export async function fetchAllTier1RawMarkets(): Promise<
  Record<Tier1PlatformId, RawMarket[]>
> {
  const entries = await Promise.all(
    TIER1_PLATFORM_IDS.map(async (id) => [id, await PLATFORM_REGISTRY[id].fetch()] as const)
  );
  return Object.fromEntries(entries) as Record<Tier1PlatformId, RawMarket[]>;
}

export type { RawMarket, NormalizedMarket, PlatformId, Tier };
