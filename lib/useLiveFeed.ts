"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveFeedPlatform } from "@/lib/liveFeedPlatform";
import { filterFeedByPlatform } from "@/lib/liveFeedMerge";
import {
  meetsProductFeedStakeThreshold,
  meetsFeedTradeEvThreshold,
} from "@/lib/feedQualification";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import type { FeedTrade } from "@/lib/kalshiTrades";
import { pipelineEvKeyForTrade } from "@/lib/pipelineEvClient";
import { usePolymarketSocketContext } from "@/lib/PolymarketSocketProvider";
import type { SocketTrade } from "@/lib/usePolymarketSocket";
import { useKalshiTrades } from "@/lib/useKalshiTrades";
import { usePipelineEvIndex } from "@/lib/usePipelineEvIndex";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";

/** Fixed rolling buffer for the Live Trades feed UI. */
export const LIVE_FEED_RETENTION = 20;

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

type HydratedFeedTrade = FeedTrade & { netEvPercent?: number | null };

function passesLiveFeedTradeGate(
  trade: HydratedFeedTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): boolean {
  if (!meetsProductFeedStakeThreshold(trade.usdNotional)) {
    return false;
  }

  const pipelineKey = pipelineEvKeyForTrade(trade);
  const pipeline = pipelineKey ? pipelineEvIndex.get(pipelineKey) : undefined;
  const tradeEvPercent = resolveFeedTradeEvPercent(
    { price: trade.price, netEvPercent: trade.netEvPercent },
    pipeline ?? null
  );

  return meetsFeedTradeEvThreshold(tradeEvPercent);
}

/** Prepend new trades, dedupe by id, cap at LIVE_FEED_RETENTION. */
function prependToFeedBuffer(
  prev: HydratedFeedTrade[],
  newTrades: HydratedFeedTrade[]
): HydratedFeedTrade[] {
  const seen = new Set<string>();
  const merged: HydratedFeedTrade[] = [];

  for (const trade of newTrades) {
    if (seen.has(trade.id)) continue;
    seen.add(trade.id);
    merged.push(trade);
  }
  for (const trade of prev) {
    if (seen.has(trade.id)) continue;
    seen.add(trade.id);
    merged.push(trade);
  }

  return merged.slice(0, LIVE_FEED_RETENTION);
}

const RECENT_TRADES_HYDRATION_MS = 200;

export function useLiveFeed(platform: LiveFeedPlatform = "all") {
  const { trades: pmTrades, connected: polymarketConnected } =
    usePolymarketSocketContext();
  const { trades: kalshiTrades, ok: kalshiOk } = useKalshiTrades();
  const [feedBuffer, setFeedBuffer] = useState<HydratedFeedTrade[]>([]);
  const [seedLoading, setSeedLoading] = useState(true);
  const seenIds = useRef(new Set<string>());
  const liveIngestReady = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const minSkeletonTimer = setTimeout(() => {
      if (!cancelled) setSeedLoading(false);
    }, RECENT_TRADES_HYDRATION_MS);

    const finishLoading = () => {
      clearTimeout(minSkeletonTimer);
      if (!cancelled) setSeedLoading(false);
    };

    void fetch("/api/trades/recent")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then((data: { trades?: HydratedFeedTrade[] }) => {
        if (cancelled) return;
        const incoming = Array.isArray(data.trades) ? data.trades : [];
        if (incoming.length > 0) {
          const hydrated = incoming
            .sort(byTimeDesc)
            .slice(0, LIVE_FEED_RETENTION);
          setFeedBuffer(hydrated);
          for (const trade of hydrated) seenIds.current.add(trade.id);
        }
        finishLoading();
      })
      .catch((error) => {
        console.error(
          "[useLiveFeed] /api/trades/recent failed",
          error instanceof Error ? error.message : error
        );
        if (!cancelled) finishLoading();
      });

    return () => {
      cancelled = true;
      clearTimeout(minSkeletonTimer);
    };
  }, []);

  const { index: pipelineEvIndex } = usePipelineEvIndex(feedBuffer);

  useEffect(() => {
    if (seedLoading) return;

    if (!liveIngestReady.current) {
      for (const t of pmTrades) seenIds.current.add(adaptPolymarketTrade(t).id);
      for (const t of kalshiTrades) seenIds.current.add(t.id);
      liveIngestReady.current = true;
      return;
    }

    const incoming: HydratedFeedTrade[] = [];

    for (const t of pmTrades) {
      const feed = adaptPolymarketTrade(t);
      if (seenIds.current.has(feed.id)) continue;
      if (!passesLiveFeedTradeGate(feed, pipelineEvIndex)) continue;
      seenIds.current.add(feed.id);
      incoming.push(feed);
    }

    for (const t of kalshiTrades) {
      if (seenIds.current.has(t.id)) continue;
      if (!passesLiveFeedTradeGate(t, pipelineEvIndex)) continue;
      seenIds.current.add(t.id);
      incoming.push(t);
    }

    if (incoming.length === 0) return;

    incoming.sort(byTimeDesc);
    setFeedBuffer((prev) => prependToFeedBuffer(prev, incoming));
  }, [seedLoading, pmTrades, kalshiTrades, pipelineEvIndex]);

  const trades = useMemo(
    () =>
      filterFeedByPlatform(feedBuffer, platform).slice(0, LIVE_FEED_RETENTION),
    [feedBuffer, platform]
  );

  return { trades, polymarketConnected, kalshiOk, seedLoading };
}
