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

async function resolveFeedTradeEvPercentsWith(
  trades: FeedTradeEvLookupInput[],
  concurrency: number,
  options?: { cacheOnly?: boolean }
): Promise<Map<string, number | null>> {
  const results = new Map<string, number | null>();

  /** One EV lookup per PM asset — fan results out to every trade row. */
  const byAsset = new Map<
    string,
    { lookupKey: string; assetId: string; tradeIds: string[]; price: number }
  >();

  for (const trade of trades) {
    const assetId = trade.assetId?.trim();
    if (!assetId) {
      results.set(trade.id, null);
      continue;
    }

    const key = assetId.toLowerCase();
    const lookupKey = normalizePipelineLookupKey(`pm:${assetId}`, "polymarket");
    const bucket = byAsset.get(key);
    if (bucket) {
      bucket.tradeIds.push(trade.id);
      continue;
    }
    byAsset.set(key, {
      lookupKey,
      assetId: key,
      tradeIds: [trade.id],
      price: trade.price,
    });
  }

  await mapWithConcurrency(
    Array.from(byAsset.values()),
    concurrency,
    async (bucket) => {
      try {
        const pipeline = await ensureFullyComputedTradeEv(
          bucket.lookupKey,
          {
            source: "polymarket",
            tokenId: bucket.assetId,
            tradePrice: bucket.price,
          },
          null,
          options
        );
        const evPercent = resolveFeedTradeEvPercent(
          { price: bucket.price },
          pipeline
        );
        for (const tradeId of bucket.tradeIds) {
          results.set(tradeId, evPercent);
        }
      } catch {
        for (const tradeId of bucket.tradeIds) {
          results.set(tradeId, null);
        }
      }
    }
  );

  return results;
}

/** Batch-resolve trade-level EV % for Polymarket feed qualification. */
export async function resolveFeedTradeEvPercents(
  trades: FeedTradeEvLookupInput[]
): Promise<Map<string, number | null>> {
  return resolveFeedTradeEvPercentsWith(trades, 6);
}

/**
 * Cached-only trade EV % for the page-load feed. Returns null for assets whose
 * EV has not been computed yet — the client hydrates those via /api/ev/trades.
 */
export async function resolveCachedFeedTradeEvPercents(
  trades: FeedTradeEvLookupInput[]
): Promise<Map<string, number | null>> {
  return resolveFeedTradeEvPercentsWith(trades, 12, { cacheOnly: true });
}
