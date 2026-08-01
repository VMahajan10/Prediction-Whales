"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildPlatformFeed } from "@/lib/liveFeedMerge";
import type { ResolvedWhaleIdentity } from "@/lib/whaleIdentityResolver";
import type { TradeSummary } from "@/lib/polymarket";
import { usePolymarketSocketContext } from "@/lib/PolymarketSocketProvider";
import {
  isQualifiedFeedTrade,
  meetsFeedStakeThreshold,
} from "@/lib/feedQualification";
import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import {
  useQualifiedWalletFilter,
  type WalletQualification,
} from "@/lib/useQualifiedWalletFilter";
import { cacheWhaleTrade, resolveAndCacheWallet } from "@/lib/whaleCache";
import { useKalshiTrades } from "@/lib/useKalshiTrades";
import { useWalletEnrichment } from "@/lib/useWalletEnrichment";
import {
  mergeWhaleTrades,
  tradeToWhale,
  type WhaleTrade,
} from "@/lib/whaleTrades";

/** Feed v1 — qualified whale feed is Polymarket-only (OQ-2 / Kalshi spike). */
const FEED_V1_EXCLUDE_KALSHI = true;
const KALSHI_WHALE_FEED_TRADES: WhaleTrade[] = FEED_V1_EXCLUDE_KALSHI ? [] : [];

function byDetectedDesc(a: WhaleTrade, b: WhaleTrade): number {
  return b.detectedAt - a.detectedAt;
}

function queueWhaleTweetNotify(whale: WhaleTrade): void {
  void fetch("/api/whales/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(whale),
  }).catch(() => {
    // Non-fatal — live feed should continue if tweet queue fails.
  });
}

function reportFeedMetrics(input: {
  tradesDetected: number;
  gatePassedTrades: number;
  whaleWallets: string[];
}): void {
  if (input.tradesDetected <= 0 && input.gatePassedTrades <= 0) return;

  void fetch("/api/feed/metrics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).catch(() => {
    // Metrics are best-effort.
  });
}

function isPolymarketTradeQualifiedForFeed(
  trade: WhaleTrade,
  walletQualification: WalletQualification | undefined
): boolean {
  if (trade.source !== "polymarket") return false;

  const wallet = trade.proxyWallet?.trim().toLowerCase();
  if (!wallet || !walletQualification) return false;

  return isQualifiedFeedTrade({
    stakeUsd: trade.usdNotional,
    walletAvgEv: walletQualification.avgEv,
    resolvedBetCount: walletQualification.resolvedBetsCount,
  });
}

function attachWhaleIdentity(
  trade: WhaleTrade,
  qualification: WalletQualification | undefined
): WhaleTrade {
  const marketTranslation =
    trade.marketTranslation ?? translateWhaleTradeMarket(trade) ?? undefined;
  const withIdentity =
    trade.whaleIdentity || !qualification?.identity
      ? trade
      : { ...trade, whaleIdentity: qualification.identity };

  if (!marketTranslation) return withIdentity;
  return { ...withIdentity, marketTranslation };
}

function isPolymarketTradeEligibleForFeed(
  trade: WhaleTrade,
  walletQualification: WalletQualification | undefined
): boolean {
  if (!isPolymarketTradeQualifiedForFeed(trade, walletQualification)) {
    return false;
  }
  return translateWhaleTradeMarket(trade) != null;
}

export function useWhaleFeed() {
  const { whaleTrades: liveSocketTrades, connected } =
    usePolymarketSocketContext();
  const { ok: kalshiOk } = useKalshiTrades();
  useWalletEnrichment();
  const [backfill, setBackfill] = useState<WhaleTrade[]>([]);
  const [backfillLoaded, setBackfillLoaded] = useState(false);
  const seenHashes = useRef<Set<string>>(new Set());
  const liveDetectedAt = useRef<Map<string, number>>(new Map());
  const metricsReported = useRef<Set<string>>(new Set());
  const qualifiedNotified = useRef<Set<string>>(new Set());
  const [newWhale, setNewWhale] = useState<WhaleTrade | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/feed");
        const data: {
          trades?: Array<
            TradeSummary & {
              whaleIdentity?: ResolvedWhaleIdentity;
              marketTranslation?: WhaleTrade["marketTranslation"];
            }
          >;
        } = await res.json();
        const whales = (data.trades ?? []).map((t) => ({
          ...tradeToWhale(t, {
            detectedAt: t.timestamp * 1000,
            isLive: false,
            usdNotional: t.size,
            source: "polymarket",
          }),
          whaleIdentity: t.whaleIdentity,
          marketTranslation: t.marketTranslation,
        }));
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

  const polymarketWalletAddresses = useMemo(
    () =>
      polymarketWhales
        .map((trade) => trade.proxyWallet?.trim().toLowerCase())
        .filter((wallet): wallet is string => Boolean(wallet)),
    [polymarketWhales]
  );
  const walletQualifications = useQualifiedWalletFilter(polymarketWalletAddresses);

  const qualifiedPolymarketWhales = useMemo(() => {
    return polymarketWhales
      .filter((trade) =>
        isPolymarketTradeEligibleForFeed(
          trade,
          trade.proxyWallet
            ? walletQualifications.get(trade.proxyWallet.trim().toLowerCase())
            : undefined
        )
      )
      .map((trade) =>
        attachWhaleIdentity(
          trade,
          trade.proxyWallet
            ? walletQualifications.get(trade.proxyWallet.trim().toLowerCase())
            : undefined
        )
      );
  }, [polymarketWhales, walletQualifications]);

  useEffect(() => {
    if (!backfillLoaded) return;

    let detected = 0;
    let passed = 0;
    const passedWallets: string[] = [];

    for (const whale of liveWhales) {
      const key = whale.transactionHash || whale.id;
      if (!key || metricsReported.current.has(key)) continue;
      if (!meetsFeedStakeThreshold(whale.usdNotional)) {
        metricsReported.current.add(key);
        continue;
      }

      metricsReported.current.add(key);
      detected += 1;

      const wallet = whale.proxyWallet?.trim().toLowerCase();
      const qualification = wallet
        ? walletQualifications.get(wallet)
        : undefined;

      if (isPolymarketTradeQualifiedForFeed(whale, qualification)) {
        passed += 1;
        if (wallet) passedWallets.push(wallet);
      }
    }

    reportFeedMetrics({
      tradesDetected: detected,
      gatePassedTrades: passed,
      whaleWallets: passedWallets,
    });
  }, [liveWhales, walletQualifications, backfillLoaded]);

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
    }
  }, [liveSocketTrades, backfillLoaded]);

  useEffect(() => {
    if (!backfillLoaded) return;

    for (const whale of liveWhales) {
      const key = whale.transactionHash || whale.id;
      if (!key || !whale.isLive || qualifiedNotified.current.has(key)) continue;

      const wallet = whale.proxyWallet?.trim().toLowerCase();
      const qualification = wallet
        ? walletQualifications.get(wallet)
        : undefined;

      if (!isPolymarketTradeEligibleForFeed(whale, qualification)) continue;

      qualifiedNotified.current.add(key);
      const enriched = attachWhaleIdentity(whale, qualification);
      setNewWhale(enriched);
      queueWhaleTweetNotify(enriched);
    }
  }, [liveWhales, backfillLoaded, walletQualifications]);

  const whales = useMemo(
    () =>
      buildPlatformFeed(
        qualifiedPolymarketWhales,
        KALSHI_WHALE_FEED_TRADES,
        "all",
        byDetectedDesc
      ),
    [qualifiedPolymarketWhales]
  );

  const dismissNewWhale = useCallback(() => setNewWhale(null), []);

  return {
    whales,
    connected,
    kalshiOk,
    backfillLoaded,
    newWhale,
    dismissNewWhale,
  };
}
