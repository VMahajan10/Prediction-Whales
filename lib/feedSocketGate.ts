import {
  logFeedFilterReject,
  resolveFeedFilterCategoryLabel,
} from "@/lib/feedFilterDiagnostics";
import {
  meetsFeedTradeEvThreshold,
  meetsFeedTieredStakeThreshold,
} from "@/lib/feedQualification";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import {
  fetchPipelineEvBatch,
  fetchPipelineTradeEv,
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
    category: resolveFeedFilterCategoryLabel(trade),
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

async function resolveSocketTradeEvPercent(
  trade: SocketTrade
): Promise<number | null> {
  const assetId = trade.assetId?.trim();
  if (!assetId) return null;

  const evRequest = {
    source: "polymarket" as const,
    tokenId: assetId,
    tradePrice: trade.price,
  };

  const whale = socketTradeToWhale(trade);
  const key = pipelineEvKeyForWhale(whale);

  const readEvPercent = (
    pipeline: Awaited<ReturnType<typeof fetchPipelineTradeEv>> | undefined
  ) => resolveFeedTradeEvPercent({ price: trade.price }, pipeline ?? null);

  const fetched = await fetchPipelineEvBatch([evRequest]);
  let pipeline: Awaited<ReturnType<typeof fetchPipelineTradeEv>> | undefined =
    key ? fetched.get(key) : undefined;
  let tradeEvPercent = readEvPercent(pipeline);

  if (tradeEvPercent == null) {
    console.log(`[Feed Gate] Enqueued trade ${trade.id} for EV calculation`);
    pipeline = (await fetchPipelineTradeEv(evRequest)) ?? undefined;
    tradeEvPercent = readEvPercent(pipeline);
  }

  return tradeEvPercent;
}

/** Async trade EV gate (+3.0% min on trade-level EV, rejects negative EV). */
export async function passesFeedSocketTradeEvGate(
  trade: SocketTrade
): Promise<boolean> {
  if (!trade.assetId?.trim()) {
    logFeedFilterReject({
      id: trade.id,
      stakeUsd: trade.usdNotional,
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
      category: resolveFeedFilterCategoryLabel(trade),
      reason: "missing_asset",
      source: "socket",
    });
    return false;
  }

  const tradeEvPercent = await resolveSocketTradeEvPercent(trade);
  const passes = meetsFeedTradeEvThreshold(tradeEvPercent);
  if (!passes) {
    logFeedFilterReject({
      id: trade.id,
      stakeUsd: trade.usdNotional,
      tradeEvPercent,
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
      category: resolveFeedFilterCategoryLabel(trade),
      reason:
        tradeEvPercent == null || !Number.isFinite(tradeEvPercent)
          ? "missing_trade_ev"
          : "trade_ev",
      source: "socket",
    });
  }

  return passes;
}

/** Full websocket broadcast gate: tiered stake + trade EV >= +3.0%. */
export async function shouldBroadcastQualifiedSocketTrade(
  trade: SocketTrade
): Promise<boolean> {
  if (!passesFeedSocketStakeGate(trade)) {
    logFeedFilterReject({
      id: trade.id,
      stakeUsd: trade.usdNotional,
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
      category: resolveFeedFilterCategoryLabel(trade),
      reason: "stake_floor",
      source: "socket",
    });
    return false;
  }
  return passesFeedSocketTradeEvGate(trade);
}
