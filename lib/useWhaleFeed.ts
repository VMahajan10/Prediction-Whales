"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedTrade } from "@/lib/kalshiTrades";
import { buildPlatformFeed } from "@/lib/liveFeedMerge";
import { useLiveFeedPlatform } from "@/lib/LiveFeedPlatformContext";
import type { TradeSummary } from "@/lib/polymarket";
import { usePolymarketSocketContext } from "@/lib/PolymarketSocketProvider";
import { cacheWhaleTrade, resolveAndCacheWallet } from "@/lib/whaleCache";
import { useKalshiTrades } from "@/lib/useKalshiTrades";
import { useWalletEnrichment } from "@/lib/useWalletEnrichment";
import {
  isWhaleNotional,
  mergeWhaleTrades,
  tradeToWhale,
  type WhaleTrade,
} from "@/lib/whaleTrades";

function byDetectedDesc(a: WhaleTrade, b: WhaleTrade): number {
  return b.detectedAt - a.detectedAt;
}

function kalshiTradeToWhale(
  trade: FeedTrade,
  detectedAt: number
): WhaleTrade {
  return tradeToWhale(
    {
      id: trade.id,
      title: trade.title,
      side: trade.side,
      outcome: trade.outcome,
      price: trade.price,
      size: trade.usdNotional,
      timestamp: trade.timestamp,
      transactionHash: "",
    },
    {
      detectedAt,
      isLive: true,
      usdNotional: trade.usdNotional,
      source: "kalshi",
      ticker: trade.ticker,
    }
  );
}

export function useWhaleFeed() {
  const { platform } = useLiveFeedPlatform();
  const { whaleTrades: liveSocketTrades, connected } =
    usePolymarketSocketContext();
  const { trades: kalshiTrades, ok: kalshiOk } = useKalshiTrades();
  useWalletEnrichment();
  const [backfill, setBackfill] = useState<WhaleTrade[]>([]);
  const [backfillLoaded, setBackfillLoaded] = useState(false);
  const seenHashes = useRef<Set<string>>(new Set());
  const liveDetectedAt = useRef<Map<string, number>>(new Map());
  const kalshiDetectedAt = useRef<Map<string, number>>(new Map());
  const [newWhale, setNewWhale] = useState<WhaleTrade | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/whales/backfill");
        const data: { trades?: TradeSummary[] } = await res.json();
        const whales = (data.trades ?? [])
          .filter((t) => isWhaleNotional(t.size))
          .map((t) =>
            tradeToWhale(t, {
              detectedAt: t.timestamp * 1000,
              isLive: false,
              usdNotional: t.size,
              source: "polymarket",
            })
          );
        setBackfill(whales);
        for (const w of whales) {
          if (w.transactionHash) seenHashes.current.add(w.transactionHash);
          if (w.transactionHash && w.proxyWallet) {
            cacheWhaleTrade({
              id: w.id,
              title: w.title,
              side: w.side,
              outcome: w.outcome,
              price: w.price,
              size: w.size,
              timestamp: w.timestamp,
              transactionHash: w.transactionHash,
              proxyWallet: w.proxyWallet,
              eventSlug: w.eventSlug,
              slug: w.slug,
              conditionId: w.conditionId,
            });
          }
        }
      } catch {
        // Backfill is optional
      } finally {
        setBackfillLoaded(true);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (!backfillLoaded) return;

    for (const t of liveSocketTrades) {
      const key = t.transactionHash;
      if (!key || seenHashes.current.has(key)) continue;

      seenHashes.current.add(key);
      const detectedAt = Date.now();
      liveDetectedAt.current.set(key, detectedAt);

      cacheWhaleTrade({
        id: t.id,
        title: t.title,
        side: t.side,
        outcome: t.outcome,
        price: t.price,
        size: t.usdNotional,
        timestamp: t.timestamp,
        transactionHash: t.transactionHash,
        assetId: t.assetId,
        eventSlug: t.eventSlug,
        slug: t.slug,
        conditionId: t.conditionId,
      });

      void resolveAndCacheWallet(t.transactionHash, t.assetId);

      setNewWhale(
        tradeToWhale(t, {
          detectedAt,
          isLive: true,
          usdNotional: t.usdNotional,
          source: "polymarket",
        })
      );
    }
  }, [liveSocketTrades, backfillLoaded]);

  const liveWhales = useMemo(() => {
    return liveSocketTrades.map((t) => {
      const key = t.transactionHash || t.id;
      let detectedAt = liveDetectedAt.current.get(key);
      if (!detectedAt) {
        detectedAt = Date.now();
        liveDetectedAt.current.set(key, detectedAt);
      }
      return tradeToWhale(t, {
        detectedAt,
        isLive: true,
        usdNotional: t.usdNotional,
        source: "polymarket",
      });
    });
  }, [liveSocketTrades]);

  const polymarketWhales = useMemo(
    () => mergeWhaleTrades(liveWhales, backfill),
    [liveWhales, backfill]
  );

  const kalshiWhales = useMemo(() => {
    const out: WhaleTrade[] = [];
    for (const trade of kalshiTrades) {
      if (!isWhaleNotional(trade.usdNotional)) continue;
      let detectedAt = kalshiDetectedAt.current.get(trade.id);
      if (!detectedAt) {
        detectedAt = Date.now();
        kalshiDetectedAt.current.set(trade.id, detectedAt);
      }
      out.push(kalshiTradeToWhale(trade, detectedAt));
    }
    return out;
  }, [kalshiTrades]);

  const whales = useMemo(
    () =>
      buildPlatformFeed(
        polymarketWhales,
        kalshiWhales,
        platform,
        byDetectedDesc
      ),
    [polymarketWhales, kalshiWhales, platform]
  );

  const dismissNewWhale = useCallback(() => setNewWhale(null), []);

  return {
    whales,
    connected,
    kalshiOk,
    backfillLoaded,
    newWhale,
    dismissNewWhale,
    platform,
  };
}
