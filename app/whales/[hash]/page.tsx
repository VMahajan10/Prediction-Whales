"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WhaleDetailsScreen from "@/components/WhaleDetailsScreen";
import LoadErrorCard from "@/components/LoadErrorCard";
import TradeDetailSkeleton from "@/components/TradeDetailSkeleton";
import { trackCopyTap } from "@/lib/copyTracking";
import {
  fetchWithTimeout,
  isFetchTimeoutError,
} from "@/lib/fetchWithTimeout";
import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import {
  buildPolymarketMarketUrl,
} from "@/lib/platformTradeUrls";
import type { MarketSummary, TradeSummary } from "@/lib/polymarket";
import {
  findMarketForTrade,
  findSocketTradeByHash,
  findTradeByHash,
  socketTradeToTradeSummary,
} from "@/lib/whaleProfile";
import { usePolymarketSocketContext } from "@/lib/PolymarketSocketProvider";
import {
  estimateWinsLosses,
  resolveEdgeIndicator,
} from "@/lib/whaleDetails";
import { getCachedWhaleTrade } from "@/lib/whaleCache";
import {
  resolveWhaleIdentity,
  sanitizeWhaleDisplayName,
} from "@/lib/whaleIdentityResolver";
import { coalesceTradeEvPercent } from "@/lib/feedTradeEv";
import { initialTradeFromStash } from "@/lib/tradeNavigationStore";
import { useResolvedWallet } from "@/lib/useResolvedWallet";
import { useWhaleTrackRecord } from "@/lib/useWhaleTrackRecord";
import type { WhaleTrade } from "@/lib/whaleTrades";

const MAX_SYNC_RETRIES = 3;
const SYNC_RETRY_DELAYS_MS = [2000, 4000, 8000];

function asWhaleTrade(trade: TradeSummary | WhaleTrade): WhaleTrade {
  if ("source" in trade && trade.source) return trade;
  return {
    ...trade,
    source: "polymarket",
    usdNotional: trade.size,
    detectedAt: trade.timestamp * 1000,
    isLive: false,
  };
}

function secondsAgo(detectedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - detectedAt) / 1000));
}

export default function WhaleDetailsPage() {
  const params = useParams();
  const hash = typeof params.hash === "string" ? params.hash : "";
  const { trades: socketTrades } = usePolymarketSocketContext();
  const socketTradesRef = useRef(socketTrades);

  const [trade, setTrade] = useState<WhaleTrade | null>(null);
  const [matchedMarket, setMatchedMarket] = useState<MarketSummary | null>(
    null
  );
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    socketTradesRef.current = socketTrades;
  }, [socketTrades]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const retryLoad = useCallback(() => {
    retryCount.current = 0;
    setLoadError(null);
    setNotFound(false);
    setRetrying(false);
    setReloadKey((k) => k + 1);
  }, []);

  const enrichMarkets = useCallback(
    async (found: WhaleTrade, signal: AbortSignal) => {
      try {
        const res = await fetchWithTimeout("/api/markets", { signal });
        if (signal.aborted || !res.ok) return;
        const data: { markets?: MarketSummary[] } = await res.json();
        const market = findMarketForTrade(found, data.markets ?? []);
        if (signal.aborted) return;
        setMatchedMarket(market);
        if (market && Number.isFinite(market.probability)) {
          setCurrentPrice(market.probability);
        }
      } catch {
        // Optional enrichment
      }
    },
    []
  );

  useEffect(() => {
    if (!hash) {
      setLoading(false);
      return;
    }

    loadAbortRef.current?.abort();
    if (retryTimer.current) clearTimeout(retryTimer.current);

    const controller = new AbortController();
    loadAbortRef.current = controller;
    const signal = controller.signal;

    setLoadError(null);
    setNotFound(false);
    setMatchedMarket(null);

    const finishLoading = () => setLoading(false);

    const instantFromSocket = () => {
      const wsTrade = findSocketTradeByHash(socketTradesRef.current, hash);
      return wsTrade ? asWhaleTrade(socketTradeToTradeSummary(wsTrade)) : null;
    };

    const instantRaw =
      initialTradeFromStash(hash) ??
      getCachedWhaleTrade(hash) ??
      instantFromSocket();
    const instant = instantRaw ? asWhaleTrade(instantRaw) : null;

    if (instant) {
      setTrade(instant);
      setCurrentPrice(instant.price);
      setNotFound(false);
      setRetrying(false);
      finishLoading();
      void enrichMarkets(instant, signal);
    } else {
      setLoading(true);
    }

    void (async () => {
      try {
        const res = await fetchWithTimeout("/api/trades", { signal });
        if (signal.aborted) return;

        const tradesData: { trades?: TradeSummary[] } = await res.json();
        if (signal.aborted) return;

        const foundTrade = findTradeByHash(tradesData.trades ?? [], hash);

        if (!foundTrade) {
          if (!instant) {
            if (retryCount.current < MAX_SYNC_RETRIES) {
              retryCount.current += 1;
              setRetrying(true);
              finishLoading();
              const delay =
                SYNC_RETRY_DELAYS_MS[retryCount.current - 1] ?? 8000;
              retryTimer.current = setTimeout(() => {
                setReloadKey((k) => k + 1);
              }, delay);
              return;
            }
            setRetrying(false);
            setNotFound(true);
            setTrade(null);
            finishLoading();
          }
          return;
        }

        retryCount.current = 0;
        setRetrying(false);
        const whaleTrade = asWhaleTrade(foundTrade);
        setTrade((prev) => ({
          ...whaleTrade,
          netEvPercent:
            whaleTrade.netEvPercent ?? prev?.netEvPercent ?? null,
          averageEv: whaleTrade.averageEv ?? prev?.averageEv ?? null,
          grossEvPercent:
            whaleTrade.grossEvPercent ?? prev?.grossEvPercent ?? null,
        }));
        setCurrentPrice(whaleTrade.price);
        setNotFound(false);
        finishLoading();
        void enrichMarkets(whaleTrade, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (!instant) {
          setLoadError(
            isFetchTimeoutError(err)
              ? "Whale trade data timed out after 8 seconds."
              : "Could not load whale trade data."
          );
          setTrade(null);
          setRetrying(false);
          finishLoading();
        }
      }
    })();

    return () => {
      controller.abort();
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [hash, reloadKey, enrichMarkets]);

  useEffect(() => {
    if (!hash || trade) return;
    const wsTrade = findSocketTradeByHash(socketTrades, hash);
    if (!wsTrade) return;
    const found = asWhaleTrade(socketTradeToTradeSummary(wsTrade));
    setTrade(found);
    setCurrentPrice(found.price);
    setNotFound(false);
    setRetrying(false);
    setLoading(false);
  }, [hash, socketTrades, trade]);

  useEffect(() => {
    if (!matchedMarket) return;

    const refresh = async () => {
      try {
        const res = await fetch("/api/markets");
        const data: { markets?: MarketSummary[] } = await res.json();
        let updated = data.markets?.find((m) => m.id === matchedMarket.id);

        if (!updated && trade?.slug) {
          const slugRes = await fetch(
            `/api/markets?slug=${encodeURIComponent(trade.slug)}`
          );
          if (slugRes.ok) {
            const slugData: { markets?: MarketSummary[] } =
              await slugRes.json();
            updated = slugData.markets?.[0];
          }
        }

        if (updated && Number.isFinite(updated.probability)) {
          setCurrentPrice(updated.probability);
        }
      } catch {
        // Keep last quote
      }
    };

    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [matchedMarket, trade?.slug]);

  const { resolvedWallet, walletResolutionFailed } = useResolvedWallet(trade);
  const displayWallet = trade?.proxyWallet ?? resolvedWallet;
  const { trackRecord, data: trackData } = useWhaleTrackRecord(displayWallet);

  const whaleIdentity = useMemo(() => {
    if (trade?.whaleIdentity) return trade.whaleIdentity;
    if (!displayWallet) {
      return resolveWhaleIdentity(null);
    }
    return resolveWhaleIdentity(displayWallet, null, {
      winRate: trackRecord?.winRate ?? null,
      resolvedBetsCount: trackRecord?.closedCount ?? null,
      avgEv: trackData?.pipelineEvAnalytics?.averageEv ?? null,
    });
  }, [trade?.whaleIdentity, displayWallet, trackRecord, trackData]);

  const marketTranslation = useMemo(() => {
    if (trade?.marketTranslation) return trade.marketTranslation;
    return trade ? translateWhaleTradeMarket(trade) : null;
  }, [trade]);

  if (loading) {
    return <TradeDetailSkeleton />;
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-md px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Feed
        </Link>
        <LoadErrorCard message={loadError} onRetry={retryLoad} />
      </main>
    );
  }

  if (retrying && !trade) {
    return (
      <main className="mx-auto max-w-md px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Feed
        </Link>
        <div className="mt-8 rounded-xl border border-pulse-border bg-pulse-card p-6">
          <p className="animate-pulse font-medium text-white">
            Syncing this whale trade…
          </p>
          <p className="mt-2 text-sm text-pulse-muted">
            This trade was just detected live and is still propagating to the
            data feed.
          </p>
        </div>
      </main>
    );
  }

  if (notFound || !trade) {
    return (
      <main className="mx-auto max-w-md px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Feed
        </Link>
        <p className="mt-8 text-pulse-no">Whale trade not found.</p>
      </main>
    );
  }

  const entryPrice = trade.price;
  const livePrice = currentPrice ?? entryPrice;
  const totalBets =
    whaleIdentity.resolvedBetsCount ?? trackRecord?.closedCount ?? null;
  const { wins, losses } = estimateWinsLosses(
    whaleIdentity.winRate ?? trackRecord?.winRate ?? null,
    totalBets
  );

  const tradeEvPercent = coalesceTradeEvPercent(trade);
  const avgEv =
    whaleIdentity.avgEv ??
    trackData?.pipelineEvAnalytics?.averageEv ??
    tradeEvPercent;

  const copyHref = buildPolymarketMarketUrl({
    eventSlug: trade.eventSlug,
    slug: trade.slug,
    conditionId: trade.conditionId ?? matchedMarket?.conditionId,
    title: trade.title,
  });

  const profileHref =
    displayWallet && !walletResolutionFailed
      ? `/traders/${encodeURIComponent(displayWallet)}`
      : null;

  return (
    <WhaleDetailsScreen
      title={trade.title}
      source="polymarket"
      side={trade.side}
      backingLabel={marketTranslation?.backingLabel ?? ""}
      entryPrice={entryPrice}
      currentPrice={livePrice}
      stakeUsd={trade.usdNotional ?? trade.size}
      ageSec={secondsAgo(trade.detectedAt ?? trade.timestamp * 1000, now)}
      whale={{
        pseudonym: sanitizeWhaleDisplayName(
          whaleIdentity.pseudonym,
          displayWallet ?? "unknown"
        ),
        initials: whaleIdentity.initials,
        profileHref,
        winRate: whaleIdentity.winRate ?? trackRecord?.winRate ?? null,
        wins,
        losses,
        totalBets,
        avgEv,
      }}
      edge={resolveEdgeIndicator(entryPrice, livePrice, trade.side)}
      copyPlayHref={copyHref}
      onCopyPlay={() => {
        trackCopyTap(trade.title, trade.size, "Copy Play");
      }}
    />
  );
}
