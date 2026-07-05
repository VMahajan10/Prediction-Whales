/**
 * Read-only mapping access — identity/orientation only, no EV fields.
 */

import {
  getMappingByKalshi,
  getMappingByPm,
  prefetchMappingsByPmTokenIds,
  type CachedMapping,
} from "@/lib/evPipeline/redisCache";
import {
  normalizeKalshiTicker,
  normalizePmTokenId,
} from "@/lib/evPipeline/crossAssetLookup";
import type { ArbPairMapping } from "@/lib/arbitrageFinder/types";

export function toArbPairMapping(row: CachedMapping): ArbPairMapping {
  return {
    polymarketTokenId: row.polymarketTokenId.toLowerCase(),
    kalshiTicker: row.kalshiTicker.toUpperCase(),
    orientation: row.orientation === "inverted" ? "inverted" : "same",
    matchMethod: row.matchMethod,
  };
}

export async function resolveMappingByPmToken(
  polymarketTokenId: string
): Promise<ArbPairMapping | null> {
  const tokenId = normalizePmTokenId(polymarketTokenId);
  if (!tokenId) return null;
  const cached = await getMappingByPm(tokenId);
  return cached ? toArbPairMapping(cached) : null;
}

export async function resolveMappingByKalshiTicker(
  kalshiTicker: string
): Promise<ArbPairMapping | null> {
  const ticker = normalizeKalshiTicker(kalshiTicker);
  if (!ticker) return null;
  const cached = await getMappingByKalshi(ticker);
  return cached ? toArbPairMapping(cached) : null;
}

export async function resolveMappingForPair(
  polymarketTokenId: string,
  kalshiTicker: string
): Promise<ArbPairMapping | null> {
  const tokenId = normalizePmTokenId(polymarketTokenId);
  const ticker = normalizeKalshiTicker(kalshiTicker);
  if (!tokenId || !ticker) return null;

  const [pmMapping, kalshiMapping] = await Promise.all([
    getMappingByPm(tokenId),
    getMappingByKalshi(ticker),
  ]);

  const cached = pmMapping ?? kalshiMapping;
  if (!cached) return null;

  return toArbPairMapping(cached);
}

export async function prefetchArbPairMappings(
  pairs: Array<{ polymarketTokenId: string; kalshiTicker: string }>
): Promise<Map<string, ArbPairMapping>> {
  const tokenIds = pairs.map((p) => p.polymarketTokenId);
  const byPm = await prefetchMappingsByPmTokenIds(tokenIds);
  const result = new Map<string, ArbPairMapping>();

  for (const pair of pairs) {
    const tokenId = normalizePmTokenId(pair.polymarketTokenId);
    if (!tokenId) continue;
    const cached = byPm.get(tokenId);
    if (cached) {
      result.set(
        `${tokenId}:${normalizeKalshiTicker(pair.kalshiTicker) ?? pair.kalshiTicker}`,
        toArbPairMapping(cached)
      );
    }
  }

  return result;
}
