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
  MIN_PRODUCT_FEED_STAKE_USD,
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

function logShadowGateDrop(trade: SocketTrade, reason: string): void {
  console.log(`[Gate Drop] Venue: POLYMARKET | Reason: ${reason}`);
}

/**
 * Cheap stake-only gate for the shadow daemon — defers EV/credibility to
 * `processWhaleTradeForXAgent` (which can compute EV on demand).
 *
 * The previous product-feed gate required cache-only EV and silently dropped
 * every trade when the pipeline cache was cold after worker restart.
 */
export function passesShadowIngestionStakeGate(trade: SocketTrade): boolean {
  if (!meetsProductFeedStakeThreshold(trade.usdNotional)) {
    logShadowGateDrop(
      trade,
      `Stake $${Math.round(trade.usdNotional)} < $${MIN_PRODUCT_FEED_STAKE_USD}`
    );
    return false;
  }

  if (!trade.assetId?.trim()) {
    logShadowGateDrop(trade, "Missing assetId for EV lookup");
    return false;
  }

  return true;
}

/** In-memory product-feed gate — stake + cached trade EV only (no Neon writes). */
export async function passesShadowProductFeedGate(
  trade: SocketTrade
): Promise<boolean> {
  if (!passesShadowIngestionStakeGate(trade)) return false;

  const evInput = socketTradeToEvInput(trade);
  const lookupKey = evInput ? pipelineEvLookupKey(evInput) : null;
  if (!evInput || !lookupKey) {
    logShadowGateDrop(trade, "Missing assetId for EV lookup");
    return false;
  }

  const pipeline = await ensureFullyComputedTradeEv(
    lookupKey,
    evInput,
    null,
    { cacheOnly: true }
  );
  const tradeEvPercent = coalesceDisplayEvPercent(pipeline);
  if (!meetsFeedTradeEvThreshold(tradeEvPercent)) {
    const evLabel =
      tradeEvPercent == null
        ? "EV unavailable (< +3%)"
        : `EV ${tradeEvPercent >= 0 ? "+" : ""}${tradeEvPercent.toFixed(1)}% < +3%`;
    logShadowGateDrop(trade, evLabel);
    return false;
  }

  return true;
}
