import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TradeSummary } from "@/lib/polymarket";
import { usePolymarketSocketContext } from "@/lib/PolymarketSocketProvider";
import { cacheWhaleTrade, resolveAndCacheWallet } from "@/lib/whaleCache";
import { useWalletEnrichment } from "@/lib/useWalletEnrichment";
import {
  isWhaleNotional,
  mergeWhaleTrades,
  tradeToWhale,
  type WhaleTrade,
} from "@/lib/whaleTrades";

export function useWhaleFeed() {
  const { whaleTrades: liveSocketTrades, connected } =
    usePolymarketSocketContext();
  useWalletEnrichment();
  const [backfill, setBackfill] = useState<WhaleTrade[]>([]);
  const [backfillLoaded, setBackfillLoaded] = useState(false);
  const seenHashes = useRef<Set<string>>(new Set());
  const liveDetectedAt = useRef<Map<string, number>>(new Map());
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

      // Persist USD-normalized trade so the detail page can resolve it
      // instantly, ahead of the ~300s-cached REST Data API.
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
      });
    });
  }, [liveSocketTrades]);

  const whales = useMemo(
    () => mergeWhaleTrades(liveWhales, backfill),
    [liveWhales, backfill]
  );

  const dismissNewWhale = useCallback(() => setNewWhale(null), []);

  return {
    whales,
    connected,
    backfillLoaded,
    newWhale,
    dismissNewWhale,
  };
}
