import { normalizePipelineLookupKey } from "@/lib/evPipeline/types";

/** Unique PM assets warmed per cron tick — caps LLM spend. */
export const MAX_WHALE_ASSETS_PER_RUN = 80;

export interface WhaleAssetEvTarget {
  assetId: string;
  tradePrice: number;
  lookupKey: string;
}

/** Dedupe whale backfill trades to one representative price per PM asset. */
export function collectUniqueWhaleAssetEvTargets(
  trades: Array<{ assetId?: string | null; price: number }>
): WhaleAssetEvTarget[] {
  const byAsset = new Map<string, WhaleAssetEvTarget>();

  for (const trade of trades) {
    const assetId = trade.assetId?.trim().toLowerCase();
    if (!assetId) continue;

    const existing = byAsset.get(assetId);
    if (!existing) {
      byAsset.set(assetId, {
        assetId,
        tradePrice: trade.price,
        lookupKey: normalizePipelineLookupKey(`pm:${assetId}`, "polymarket"),
      });
      continue;
    }

    const currentDist = Math.abs(existing.tradePrice - 0.5);
    const nextDist = Math.abs(trade.price - 0.5);
    if (nextDist < currentDist) {
      byAsset.set(assetId, { ...existing, tradePrice: trade.price });
    }
  }

  return Array.from(byAsset.values()).slice(0, MAX_WHALE_ASSETS_PER_RUN);
}
