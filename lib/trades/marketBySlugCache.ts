import "server-only";

import { fetchMarketBySlug, type MarketSummary } from "@/lib/polymarket";

const TTL_MS = 60_000;

type Entry = { market: MarketSummary | null; at: number };

function cacheMap(): Map<string, Entry> {
  const g = globalThis as typeof globalThis & {
    __marketBySlugCache?: Map<string, Entry>;
  };
  if (!g.__marketBySlugCache) {
    g.__marketBySlugCache = new Map();
  }
  return g.__marketBySlugCache;
}

export async function getCachedMarketBySlug(
  slug: string
): Promise<MarketSummary | null> {
  const key = slug.trim().toLowerCase();
  if (!key) return null;

  const hit = cacheMap().get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.market;
  }

  const market = await fetchMarketBySlug(slug);
  cacheMap().set(key, { market, at: Date.now() });
  return market;
}
