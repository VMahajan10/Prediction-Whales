import {
  meetsFeedTradeEvThreshold,
  meetsFeedTieredStakeThreshold,
} from "@/lib/feedQualification";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import {
  fetchPipelineEvBatch,
  pipelineEvKeyForWhale,
} from "@/lib/pipelineEvClient";
import type { SocketTrade } from "@/lib/usePolymarketSocket";
import { tradeToWhale } from "@/lib/whaleTrades";

/** Synchronous tiered stake floor — sports/culture $250, default $500, macro/politics $1k. */
export function passesFeedSocketStakeGate(trade: SocketTrade): boolean {
  return meetsFeedTieredStakeThreshold({
    stakeUsd: trade.usdNotional,
    title: trade.title,
    slug: trade.slug,
    eventSlug: trade.eventSlug,
  });
}

function socketTradeToWhale(trade: SocketTrade) {
  return tradeToWhale(
    {
      id: trade.id,
      title: trade.title,
      side: trade.side,
      outcome: trade.outcome,
      price: trade.price,
      size: trade.size,
      timestamp: trade.timestamp,
      transactionHash: trade.transactionHash,
      assetId: trade.assetId,
      eventSlug: trade.eventSlug,
      slug: trade.slug,
      conditionId: trade.conditionId,
    },
    { usdNotional: trade.usdNotional, source: "polymarket", isLive: true }
  );
}

/** Async trade EV gate (+3.0% min, rejects negative EV). */
export async function passesFeedSocketTradeEvGate(
  trade: SocketTrade
): Promise<boolean> {
  if (!trade.assetId?.trim()) return false;

  const fetched = await fetchPipelineEvBatch([
    {
      source: "polymarket",
      tokenId: trade.assetId,
      tradePrice: trade.price,
    },
  ]);

  const whale = socketTradeToWhale(trade);
  const key = pipelineEvKeyForWhale(whale);
  const pipeline = key ? fetched.get(key) : undefined;
  const tradeEvPercent = resolveFeedTradeEvPercent(
    { price: trade.price },
    pipeline ?? null
  );

  return meetsFeedTradeEvThreshold(tradeEvPercent);
}

/** Full websocket broadcast gate: tiered stake + trade EV >= +3.0%. */
export async function shouldBroadcastQualifiedSocketTrade(
  trade: SocketTrade
): Promise<boolean> {
  if (!passesFeedSocketStakeGate(trade)) return false;
  return passesFeedSocketTradeEvGate(trade);
}
