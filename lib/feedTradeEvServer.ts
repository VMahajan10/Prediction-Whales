import "server-only";

import { mapWithConcurrency } from "@/lib/clvPriceHistory";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import { ensureFullyComputedTradeEv } from "@/lib/evPipeline/resolveTradeEv";
import { initGlobalLocalEvCache } from "@/lib/evPipeline/redisCache";
import { normalizePipelineLookupKey } from "@/lib/evPipeline/types";

initGlobalLocalEvCache();

export interface FeedTradeEvLookupInput {
  id: string;
  price: number;
  assetId?: string | null;
}

/** Batch-resolve trade-level EV % for Polymarket feed qualification. */
export async function resolveFeedTradeEvPercents(
  trades: FeedTradeEvLookupInput[]
): Promise<Map<string, number | null>> {
  const results = new Map<string, number | null>();

  await mapWithConcurrency(trades, 6, async (trade) => {
    const assetId = trade.assetId?.trim();
    if (!assetId) {
      results.set(trade.id, null);
      return;
    }

    const lookupKey = normalizePipelineLookupKey(`pm:${assetId}`, "polymarket");
    try {
      const pipeline = await ensureFullyComputedTradeEv(lookupKey, {
        source: "polymarket",
        tokenId: assetId,
        tradePrice: trade.price,
      });
      results.set(
        trade.id,
        resolveFeedTradeEvPercent({ price: trade.price }, pipeline)
      );
    } catch {
      results.set(trade.id, null);
    }
  });

  return results;
}
