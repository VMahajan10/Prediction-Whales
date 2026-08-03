import "server-only";

import { mapWithConcurrency } from "@/lib/clvPriceHistory";
import { ensureFullyComputedTradeEv } from "@/lib/evPipeline/resolveTradeEv";
import { getTradeEvLookup, initGlobalLocalEvCache } from "@/lib/evPipeline/redisCache";
import {
  collectUniqueWhaleAssetEvTargets,
  type WhaleAssetEvTarget,
} from "@/lib/evPipeline/whaleFeedEvTargets";
import { fetchWhaleBackfill } from "@/lib/polymarket";

initGlobalLocalEvCache();

/** Concurrent EV resolutions during whale prewarm. */
const WHALE_EV_WARM_CONCURRENCY = 2;
const WHALE_EV_WARM_INTER_BATCH_MS = 500;

export type { WhaleAssetEvTarget };
export { collectUniqueWhaleAssetEvTargets };

async function shouldSkipWhaleEvWarm(lookupKey: string): Promise<boolean> {
  const cached = await getTradeEvLookup(lookupKey);
  if (!cached) return false;
  if (cached.pTrue != null && Number.isFinite(cached.pTrue)) return true;
  const ev = cached.netEvPercent ?? cached.averageEv;
  return ev != null && Number.isFinite(ev);
}

/**
 * Precompute trade-level EV for recent whale-feed PM assets so page-load reads
 * hit warm cache instead of triggering inline LLM resolution.
 */
export async function warmWhaleFeedTradeEv(): Promise<{
  candidates: number;
  skippedCached: number;
  warmed: number;
  errors: number;
}> {
  const trades = await fetchWhaleBackfill();
  const targets = collectUniqueWhaleAssetEvTargets(trades);

  let skippedCached = 0;
  let warmed = 0;
  let errors = 0;

  for (let i = 0; i < targets.length; i += WHALE_EV_WARM_CONCURRENCY) {
    if (i > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, WHALE_EV_WARM_INTER_BATCH_MS)
      );
    }

    const batch = targets.slice(i, i + WHALE_EV_WARM_CONCURRENCY);
    await mapWithConcurrency(batch, WHALE_EV_WARM_CONCURRENCY, async (target) => {
      try {
        if (await shouldSkipWhaleEvWarm(target.lookupKey)) {
          skippedCached += 1;
          return;
        }

        await ensureFullyComputedTradeEv(target.lookupKey, {
          source: "polymarket",
          tokenId: target.assetId,
          tradePrice: target.tradePrice,
        });
        warmed += 1;
      } catch {
        errors += 1;
      }
    });
  }

  return {
    candidates: targets.length,
    skippedCached,
    warmed,
    errors,
  };
}
