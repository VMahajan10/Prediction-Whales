"use client";

import { useMemo } from "react";
import type { LiveFeedPlatform } from "@/lib/liveFeedPlatform";
import { buildPlatformFeed } from "@/lib/liveFeedMerge";
import {
  meetsFeedTieredStakeThreshold,
  meetsFeedTradeEvThreshold,
} from "@/lib/feedQualification";
import { resolveFeedFilterCategoryLabel } from "@/lib/feedFilterDiagnostics";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import type { FeedTrade } from "@/lib/kalshiTrades";
import { pipelineEvKeyForTrade } from "@/lib/pipelineEvClient";
import { usePolymarketSocketContext } from "@/lib/PolymarketSocketProvider";
import type { SocketTrade } from "@/lib/usePolymarketSocket";
import { useKalshiTrades } from "@/lib/useKalshiTrades";
import { usePipelineEvIndex } from "@/lib/usePipelineEvIndex";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";

export { MAX_FEED_ITEMS as MAX_TRADES } from "@/lib/liveFeedMerge";

function byTimeDesc(a: FeedTrade, b: FeedTrade): number {
  return b.timestamp - a.timestamp;
}

function adaptPolymarketTrade(t: SocketTrade): FeedTrade {
  return {
    id: t.id,
    source: "polymarket",
    title: t.title,
    outcome: t.outcome,
    side: t.side,
    price: t.price,
    size: t.size,
    usdNotional: t.usdNotional,
    timestamp: t.timestamp,
    traceable: true,
    transactionHash: t.transactionHash,
    slug: t.slug,
    assetId: t.assetId,
  };
}

export function buildLiveFeedTrades(
  pmTrades: FeedTrade[],
  kalshiTrades: FeedTrade[],
  platform: LiveFeedPlatform
): FeedTrade[] {
  return buildPlatformFeed(pmTrades, kalshiTrades, platform, byTimeDesc);
}

function passesLiveFeedTradeGate(
  trade: FeedTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): boolean {
  if (
    !meetsFeedTieredStakeThreshold({
      stakeUsd: trade.usdNotional,
      title: trade.title,
      slug: trade.slug,
      category: resolveFeedFilterCategoryLabel(trade),
    })
  ) {
    return false;
  }

  const pipelineKey = pipelineEvKeyForTrade(trade);
  const pipeline = pipelineKey ? pipelineEvIndex.get(pipelineKey) : undefined;
  const tradeEvPercent = resolveFeedTradeEvPercent(
    { price: trade.price },
    pipeline ?? null
  );

  return meetsFeedTradeEvThreshold(tradeEvPercent);
}

export function useLiveFeed(platform: LiveFeedPlatform = "all") {
  const { trades: pmTrades, connected: polymarketConnected } =
    usePolymarketSocketContext();
  const { trades: kalshiTrades, ok: kalshiOk } = useKalshiTrades();

  const rawTrades = useMemo(() => {
    const pmMap = new Map<string, FeedTrade>();
    const kalshiMap = new Map<string, FeedTrade>();

    for (const t of pmTrades) {
      const feed = adaptPolymarketTrade(t);
      pmMap.set(feed.id, feed);
    }

    for (const t of kalshiTrades) {
      kalshiMap.set(t.id, t);
    }

    return buildLiveFeedTrades(
      Array.from(pmMap.values()),
      Array.from(kalshiMap.values()),
      platform
    );
  }, [pmTrades, kalshiTrades, platform]);

  const { index: pipelineEvIndex } = usePipelineEvIndex(rawTrades);

  const trades = useMemo(
    () =>
      rawTrades.filter((trade) =>
        passesLiveFeedTradeGate(trade, pipelineEvIndex)
      ),
    [rawTrades, pipelineEvIndex]
  );

  return { trades, polymarketConnected, kalshiOk };
}
