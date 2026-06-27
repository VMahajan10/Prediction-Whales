"use client";

import { useMemo } from "react";
import type { LiveFeedPlatform } from "@/lib/liveFeedPlatform";
import { buildPlatformFeed } from "@/lib/liveFeedMerge";
import type { FeedTrade } from "@/lib/kalshiTrades";
import { usePolymarketSocketContext } from "@/lib/PolymarketSocketProvider";
import type { SocketTrade } from "@/lib/usePolymarketSocket";
import { useKalshiTrades } from "@/lib/useKalshiTrades";

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
  };
}

export function buildLiveFeedTrades(
  pmTrades: FeedTrade[],
  kalshiTrades: FeedTrade[],
  platform: LiveFeedPlatform
): FeedTrade[] {
  return buildPlatformFeed(pmTrades, kalshiTrades, platform, byTimeDesc);
}

export function useLiveFeed(platform: LiveFeedPlatform = "all") {
  const { trades: pmTrades, connected: polymarketConnected } =
    usePolymarketSocketContext();
  const { trades: kalshiTrades, ok: kalshiOk } = useKalshiTrades();

  const trades = useMemo(() => {
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

  return { trades, polymarketConnected, kalshiOk };
}
