"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WhaleDetailsScreen from "@/components/WhaleDetailsScreen";
import LoadErrorCard from "@/components/LoadErrorCard";
import TradeDetailSkeleton from "@/components/TradeDetailSkeleton";
import { trackCopyTap } from "@/lib/copyTracking";
import {
  fetchWithTimeout,
  isFetchTimeoutError,
} from "@/lib/fetchWithTimeout";
import type { KalshiMarketDetail, KalshiTradeDetail } from "@/lib/kalshiDetail";
import { kalshiYesMidFromMarket } from "@/lib/kalshiDetail";
import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import { buildKalshiMarketUrl } from "@/lib/platformTradeUrls";
import {
  initialKalshiTradeFromStash,
  peekStashedKalshiTrade,
} from "@/lib/tradeNavigationStore";
import {
  estimateWinsLosses,
  resolveEdgeIndicator,
} from "@/lib/whaleDetails";
import { resolveWhaleIdentity } from "@/lib/whaleIdentityResolver";
import type { WhaleTrade } from "@/lib/whaleTrades";

function secondsAgo(detectedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - detectedAt) / 1000));
}

function kalshiDetailToWhaleTrade(
  trade: KalshiTradeDetail,
  whaleIdentity?: WhaleTrade["whaleIdentity"],
  marketTranslation?: WhaleTrade["marketTranslation"]
): WhaleTrade {
  return {
    id: trade.tradeId,
    title: trade.title,
    side: trade.side,
    outcome: trade.outcome,
    price: trade.price,
    size: trade.usdNotional,
    timestamp: trade.timestamp,
    transactionHash: trade.tradeId,
    source: "kalshi",
    usdNotional: trade.usdNotional,
    detectedAt: trade.timestamp * 1000,
    isLive: false,
    ticker: trade.ticker,
    whaleIdentity,
    marketTranslation,
  };
}

export default function KalshiWhaleDetailsPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const tradeId =
    typeof params.id === "string" ? decodeURIComponent(params.id) : "";
  const tickerHint = searchParams.get("ticker") ?? undefined;

  const [trade, setTrade] = useState<WhaleTrade | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(
    () => !initialKalshiTradeFromStash(tradeId)
  );
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setNotFound(false);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!tradeId) {
      setLoading(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    setLoadError(null);
    setNotFound(false);

    const stashed = peekStashedKalshiTrade(tradeId);
    const instant = stashed?.trade
      ? kalshiDetailToWhaleTrade(stashed.trade)
      : null;

    if (instant) {
      setTrade(instant);
      setCurrentPrice(instant.price);
      setLoading(false);
    } else {
      setLoading(true);
    }

    void (async () => {
      try {
        const qs = new URLSearchParams({ trade_id: tradeId });
        if (tickerHint) qs.set("ticker", tickerHint);

        const res = await fetchWithTimeout(
          `/api/kalshi/trade-detail?${qs.toString()}`,
          { signal }
        );
        if (signal.aborted) return;

        if (res.status === 404) {
          if (!instant) {
            setNotFound(true);
            setTrade(null);
            setLoading(false);
          }
          return;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = (await res.json()) as {
          trade: KalshiTradeDetail;
          market: KalshiMarketDetail | null;
        };
        if (signal.aborted) return;

        const whaleTrade = kalshiDetailToWhaleTrade(data.trade);
        setTrade(whaleTrade);
        const mid = data.market ? kalshiYesMidFromMarket(data.market) : null;
        setCurrentPrice(mid ?? data.trade.price);
        setNotFound(false);
        setLoading(false);
      } catch (err) {
        if (signal.aborted) return;
        if (!instant) {
          setLoadError(
            isFetchTimeoutError(err)
              ? "Kalshi trade data timed out after 8 seconds."
              : "Could not load Kalshi trade data."
          );
          setTrade(null);
          setLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [tradeId, tickerHint, reloadKey]);

  const marketTranslation = useMemo(() => {
    if (trade?.marketTranslation) return trade.marketTranslation;
    return trade ? translateWhaleTradeMarket(trade) : null;
  }, [trade]);

  if (loading && !trade) {
    return <TradeDetailSkeleton />;
  }

  if (loadError && !trade) {
    return (
      <main className="mx-auto max-w-md px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Feed
        </Link>
        <LoadErrorCard message={loadError} onRetry={retryLoad} />
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

  const whaleIdentity = trade.whaleIdentity ?? resolveWhaleIdentity(null);
  const entryPrice = trade.price;
  const livePrice = currentPrice ?? entryPrice;
  const totalBets = whaleIdentity.resolvedBetsCount;
  const { wins, losses } = estimateWinsLosses(
    whaleIdentity.winRate,
    totalBets
  );

  const copyHref = buildKalshiMarketUrl({
    marketTicker: trade.ticker,
    title: trade.title,
  });

  return (
    <WhaleDetailsScreen
      title={trade.title}
      source="kalshi"
      side={trade.side}
      backingLabel={marketTranslation?.backingLabel ?? `Backing ${trade.outcome}`}
      entryPrice={entryPrice}
      currentPrice={livePrice}
      stakeUsd={trade.usdNotional}
      ageSec={secondsAgo(trade.detectedAt, now)}
      whale={{
        pseudonym: whaleIdentity.pseudonym,
        initials: whaleIdentity.initials,
        profileHref: null,
        winRate: whaleIdentity.winRate,
        wins,
        losses,
        totalBets,
        avgEv: whaleIdentity.avgEv,
      }}
      edge={resolveEdgeIndicator(entryPrice, livePrice, trade.side)}
      copyPlayHref={copyHref}
      onCopyPlay={() => {
        trackCopyTap(trade.title, trade.usdNotional, "Copy Play");
      }}
    />
  );
}
