import "server-only";

import { coalesceDisplayEvPercent } from "@/lib/evPipeline/tradeEvRecord";
import { ensureFullyComputedTradeEv } from "@/lib/evPipeline/resolveTradeEv";
import {
  pipelineEvLookupKey,
  type PipelineTradeEvInput,
} from "@/lib/evPipeline/types";
import {
  meetsFeedTradeEvThreshold,
  meetsProductFeedStakeThreshold,
} from "@/lib/feedQualification";
import type { SocketTrade } from "@/lib/polymarketLiveSocket";

export function socketTradeToEvInput(trade: SocketTrade): PipelineTradeEvInput | null {
  const tokenId = trade.assetId?.trim();
  if (!tokenId) return null;

  return {
    source: "polymarket",
    tokenId,
    tradePrice: trade.price,
    title: trade.title,
    slug: trade.slug ?? trade.eventSlug ?? undefined,
  };
}

/** In-memory product-feed gate — stake + cached trade EV only (no Neon writes). */
export async function passesShadowProductFeedGate(
  trade: SocketTrade
): Promise<boolean> {
  if (!meetsProductFeedStakeThreshold(trade.usdNotional)) return false;

  const evInput = socketTradeToEvInput(trade);
  const lookupKey = evInput ? pipelineEvLookupKey(evInput) : null;
  if (!evInput || !lookupKey) return false;

  const pipeline = await ensureFullyComputedTradeEv(
    lookupKey,
    evInput,
    null,
    { cacheOnly: true }
  );
  const tradeEvPercent = coalesceDisplayEvPercent(pipeline);
  return meetsFeedTradeEvThreshold(tradeEvPercent);
}
