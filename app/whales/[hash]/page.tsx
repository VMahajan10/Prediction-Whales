"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CopyBetSignal from "@/components/CopyBetSignal";
import CrossMarketEvBadge from "@/components/CrossMarketEvBadge";
import BookmarkTraderButton from "@/components/BookmarkTraderButton";
import LoadErrorCard from "@/components/LoadErrorCard";
import TradeDetailSkeleton, {
  EnrichmentSkeleton,
} from "@/components/TradeDetailSkeleton";
import { getCachedWhaleTrade } from "@/lib/whaleCache";
import { consumeStashedTrade } from "@/lib/tradeNavigationStore";
import {
  fetchWithTimeout,
  isFetchTimeoutError,
} from "@/lib/fetchWithTimeout";
import {
  findMarketForTrade,
  findRelatedTrades,
  findSocketTradeByHash,
  findTradeByHash,
  socketTradeToTradeSummary,
  truncateTxHash,
} from "@/lib/whaleProfile";
import { usePolymarketSocketContext } from "@/lib/PolymarketSocketProvider";
import {
  type MarketSummary,
  type TradeSummary,
} from "@/lib/polymarket";
import { useResolvedWallet } from "@/lib/useResolvedWallet";
import { useCrossMarketEvIndex } from "@/lib/useCrossMarketEvIndex";
import { isPolymarketTrade } from "@/lib/tradeSource";
import { getFullDate, getTimeAgo, getUtcString } from "@/lib/time";
import { formatImpliedProbabilitySummary } from "@/lib/tradeDetail";
import WhaleTrackRecord from "@/components/WhaleTrackRecord";

const MIN_WHALE_THRESHOLD = 500;
const NEARBY_MIN_SIZE = 100;
const MAX_SYNC_RETRIES = 3;
const SYNC_RETRY_DELAYS_MS = [2000, 4000, 8000];
const US_WEEKLY_WAGE = 1154;
const BAR_UNIT = 125;

function getPlainEnglishBet(trade: TradeSummary): string {
  if (trade.side === "SELL") {
    return "they're EXITING a previous bet on this outcome";
  }
  const outcome = trade.outcome.toLowerCase();
  if (outcome === "yes") return "this WILL happen";
  if (outcome === "no") return "this WON'T happen";
  return `the outcome "${trade.outcome}" will happen`;
}

function getOddsComparison(prob: number): string {
  if (prob < 0.05) return "Getting heads 4 times in a row";
  if (prob < 0.1) return "Rolling a 1 on a dice";
  if (prob < 0.2) return "Drawing a specific suit from a deck";
  if (prob < 0.33) return "Rolling a 1 or 2 on a dice";
  if (prob < 0.5) return "Flipping heads twice in a row";
  if (prob < 0.67) return "Flipping heads once";
  if (prob < 0.85) return "Drawing a red card from a deck";
  return "Rolling anything but a 1 on a dice";
}

const formatDollars = (n: number): string => {
  if (n >= 1000000) return `$${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000)
    return `$${n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  return `$${n.toFixed(2)}`;
};

const formatVol = (v: number): string => {
  const n = Number(v);
  if (n >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(0) + "k";
  return "$" + n.toFixed(0);
};

type MatchConfidence = "high" | "low";

interface MarketMatchResult {
  market: MarketSummary;
  confidence: MatchConfidence;
}

function findMatchingMarket(
  tradeTitle: string,
  markets: MarketSummary[]
): MarketMatchResult | null {
  if (!tradeTitle || !markets?.length) return null;

  const title = tradeTitle.toLowerCase().trim();

  const exact = markets.find(
    (m) => m.question?.toLowerCase().trim() === title
  );
  if (exact) return { market: exact, confidence: "high" };

  const strong = markets.find((m) => {
    const q = m.question?.toLowerCase().trim() ?? "";
    return title.includes(q) || q.includes(title);
  });
  if (strong) return { market: strong, confidence: "low" };

  const titleWords = title.split(" ").filter((w) => w.length > 4);

  for (const m of markets) {
    const q = m.question?.toLowerCase() ?? "";
    const matchCount = titleWords.filter((w) => q.includes(w)).length;
    if (matchCount >= 4) {
      return { market: m, confidence: "low" };
    }
  }

  return null;
}

function getTopPercentTier(size: number): string {
  if (size > 10000) return "1";
  if (size > 5000) return "5";
  return "10";
}

function getTimingAnalysis(timestamp: number): string {
  const hour = new Date(timestamp * 1000).getHours();
  if (hour >= 22 || hour <= 6) {
    return "⏰ Late night trade (after hours). Trades placed outside market hours sometimes indicate reaction to breaking news or overseas events.";
  }
  if (hour >= 9 && hour <= 16) {
    return "⏰ Business hours trade. Normal trading window — no unusual timing signals.";
  }
  return "⏰ Evening trade. Common for retail traders after work hours.";
}

function getMarketVolumeContext(
  size: number,
  volume: number
): { pct: number; message: string } | null {
  if (volume <= 0) return null;
  const pct = (size / volume) * 100;
  let message: string;
  if (pct > 1) {
    message =
      "That's significant — this one trade moved the market. When a single bet is >1% of total volume, it often shifts the price.";
  } else if (pct > 0.1) {
    message =
      "Meaningful but not market-moving. This whale is a notable participant.";
  } else {
    message =
      "Small relative to total market size. This whale is one of many.";
  }
  return { pct, message };
}

function BarComparison({
  label,
  amount,
  filled,
}: {
  label: string;
  amount: string;
  filled: number;
}) {
  return (
    <div className="mb-2">
      <div className="mb-1 flex justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span>{amount}</span>
      </div>
      <div className="flex gap-1">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className={`h-3 flex-1 rounded-sm ${
              i < filled ? "bg-pulse-accent" : "bg-slate-700"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function StatBox({
  value,
  label,
  explain,
  valueClassName = "text-white",
}: {
  value: string;
  label: string;
  explain: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
      <p className={`text-xl font-bold ${valueClassName}`}>{value}</p>
      <p className="mb-2 text-xs font-medium text-slate-300">{label}</p>
      <p className="text-xs leading-relaxed text-slate-400">{explain}</p>
    </div>
  );
}

function WhaleProfileSkeleton() {
  return <TradeDetailSkeleton />;
}

export default function WhaleProfilePage() {
  const params = useParams();
  const hash = typeof params.hash === "string" ? params.hash : "";
  const { trades: socketTrades } = usePolymarketSocketContext();
  const socketTradesRef = useRef(socketTrades);
  socketTradesRef.current = socketTrades;

  const [trade, setTrade] = useState<TradeSummary | null>(null);
  const [relatedTrades, setRelatedTrades] = useState<TradeSummary[]>([]);
  const [matchedMarket, setMatchedMarket] = useState<MarketSummary | null>(
    null
  );
  const [matchConfidence, setMatchConfidence] = useState<MatchConfidence | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [marketsLoading, setMarketsLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [showAllNearby, setShowAllNearby] = useState(false);
  const [liveMarketPrice, setLiveMarketPrice] = useState<number | null>(null);
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const enrichAbortRef = useRef<AbortController | null>(null);

  const retryLoad = useCallback(() => {
    retryCount.current = 0;
    setLoadError(null);
    setNotFound(false);
    setRetrying(false);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    retryCount.current = 0;
    setMatchedMarket(null);
    setMatchConfidence(null);
    setLiveMarketPrice(null);
  }, [hash]);

  const enrichMarkets = useCallback(
    async (found: TradeSummary, signal: AbortSignal) => {
      setMarketsLoading(true);
      try {
        const [pmResult, piResult] = await Promise.allSettled([
          fetchWithTimeout("/api/markets", { signal }),
          fetchWithTimeout("/api/kalshi", { signal }),
        ]);
        if (signal.aborted) return;

        const allMarkets: MarketSummary[] = [];
        let pmMarkets: MarketSummary[] = [];

        if (pmResult.status === "fulfilled" && pmResult.value.ok) {
          const pmData: { markets?: MarketSummary[] } =
            await pmResult.value.json();
          pmMarkets = pmData.markets ?? [];
          allMarkets.push(...pmMarkets);
        }
        if (piResult.status === "fulfilled" && piResult.value.ok) {
          const piData: { markets?: MarketSummary[] } =
            await piResult.value.json();
          allMarkets.push(...(piData.markets ?? []));
        }

        const matchResult = findMatchingMarket(found.title, pmMarkets);
        let market = matchResult?.market ?? null;
        let confidence = matchResult?.confidence ?? null;

        if (!market) {
          market = findMarketForTrade(found, allMarkets);
          if (market) confidence = "low";
        }

        if (!market && found.slug) {
          try {
            const slugRes = await fetchWithTimeout(
              `/api/markets?slug=${encodeURIComponent(found.slug)}`,
              { signal }
            );
            if (slugRes.ok) {
              const slugData: { markets?: MarketSummary[] } =
                await slugRes.json();
              market = slugData.markets?.[0] ?? null;
              if (market) confidence = "high";
            }
          } catch {
            // Slug lookup is optional
          }
        }

        if (signal.aborted) return;

        setMatchedMarket(market);
        setMatchConfidence(confidence);
        if (market && Number.isFinite(market.probability)) {
          setLiveMarketPrice(market.probability);
        }
      } catch {
        // Market enrichment is optional
      } finally {
        if (!signal.aborted) setMarketsLoading(false);
      }
    },
    []
  );

  // Market enrichment — once per trade, never tied to socket ticks or load retries.
  useEffect(() => {
    if (!trade?.transactionHash) return;

    enrichAbortRef.current?.abort();
    const controller = new AbortController();
    enrichAbortRef.current = controller;

    void enrichMarkets(trade, controller.signal);

    return () => {
      controller.abort();
    };
  }, [trade?.transactionHash, enrichMarkets]);

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

    const finishLoading = () => setLoading(false);

    const instantFromSocket = () => {
      const wsTrade = findSocketTradeByHash(socketTradesRef.current, hash);
      return wsTrade ? socketTradeToTradeSummary(wsTrade) : null;
    };

    const instant =
      consumeStashedTrade(hash) ??
      instantFromSocket() ??
      getCachedWhaleTrade(hash);

    if (instant) {
      setTrade(instant);
      setLiveMarketPrice(null);
      setNotFound(false);
      setRetrying(false);
      finishLoading();
      return () => {
        controller.abort();
        if (retryTimer.current) clearTimeout(retryTimer.current);
      };
    }

    setLoading(true);

    void (async () => {
      try {
        const res = await fetchWithTimeout("/api/trades", { signal });
        if (signal.aborted) return;

        const tradesData: { trades?: TradeSummary[] } = await res.json();
        if (signal.aborted) return;

        const trades = tradesData.trades ?? [];
        const foundTrade = findTradeByHash(trades, hash);

        if (!foundTrade) {
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
          return;
        }

        retryCount.current = 0;
        setRetrying(false);
        setTrade(foundTrade);
        setRelatedTrades(findRelatedTrades(trades, foundTrade));
        setLiveMarketPrice(null);
        setNotFound(false);
        finishLoading();
      } catch (err) {
        if (signal.aborted) return;

        setLoadError(
          isFetchTimeoutError(err)
            ? "Whale trade data timed out after 8 seconds."
            : "Could not load whale trade data."
        );
        setTrade(null);
        setRetrying(false);
        finishLoading();
      }
    })();

    return () => {
      controller.abort();
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [hash, reloadKey]);

  // Fill in from live socket when trade wasn't in stash/cache on first paint.
  useEffect(() => {
    if (!hash || trade) return;
    const wsTrade = findSocketTradeByHash(socketTrades, hash);
    if (!wsTrade) return;

    const found = socketTradeToTradeSummary(wsTrade);
    setTrade(found);
    setLiveMarketPrice(null);
    setNotFound(false);
    setRetrying(false);
    setLoading(false);
  }, [hash, socketTrades, trade]);

  const { resolvedWallet, walletResolutionFailed } = useResolvedWallet(trade);

  const displayWallet = useMemo(
    () => trade?.proxyWallet ?? resolvedWallet,
    [trade?.proxyWallet, resolvedWallet]
  );

  const { index: evIndex } = useCrossMarketEvIndex();

  const tradeEvInput = useMemo(() => {
    if (!trade || !isPolymarketTrade(trade)) return null;
    return {
      source: "polymarket" as const,
      price: trade.price,
      slug: trade.slug,
    };
  }, [trade]);

  useEffect(() => {
    if (!matchedMarket) return;

    const applyQuote = (market: MarketSummary | null | undefined) => {
      if (market && Number.isFinite(market.probability)) {
        setLiveMarketPrice(market.probability);
      }
    };

    const refresh = async () => {
      try {
        const endpoint =
          matchedMarket.source === "kalshi" ? "/api/kalshi" : "/api/markets";
        const res = await fetch(endpoint);
        const data: { markets?: MarketSummary[] } = await res.json();
        let updated = data.markets?.find((m) => m.id === matchedMarket.id);

        if (
          !updated &&
          trade?.slug &&
          matchedMarket.source === "polymarket"
        ) {
          const slugRes = await fetch(
            `/api/markets?slug=${encodeURIComponent(trade.slug)}`
          );
          if (slugRes.ok) {
            const slugData: { markets?: MarketSummary[] } =
              await slugRes.json();
            updated = slugData.markets?.[0];
          }
        }

        applyQuote(updated);
      } catch {
        // Keep last known live quote on failure
      }
    };

    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [matchedMarket, trade?.slug]);

  const filteredNearby = useMemo(() => {
    return relatedTrades
      .filter((t) => t.size >= NEARBY_MIN_SIZE)
      .sort((a, b) => b.size - a.size);
  }, [relatedTrades]);

  const visibleNearby = showAllNearby
    ? filteredNearby
    : filteredNearby.slice(0, 5);

  if (loading) {
    return <WhaleProfileSkeleton />;
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Dashboard
        </Link>
        <LoadErrorCard message={loadError} onRetry={retryLoad} />
      </main>
    );
  }

  if (retrying && !trade) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Dashboard
        </Link>
        <div className="mt-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
          <p className="animate-pulse font-medium text-white">
            Syncing this whale trade…
          </p>
          <p className="mt-2 text-sm text-slate-400">
            This trade was just detected live and is still propagating to the
            data feed. Hang tight — this usually takes a few seconds.
          </p>
        </div>
      </main>
    );
  }

  if (notFound || !trade) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Dashboard
        </Link>
        <p className="mt-8 text-red-400">Whale trade not found.</p>
      </main>
    );
  }

  const price = trade.price;
  const priceCents = (price * 100).toFixed(1);
  const isNoBet =
    trade.outcome?.toLowerCase() === "no" ||
    trade.outcome?.toLowerCase() === "no ";
  const displayProbability =
    liveMarketPrice ??
    (matchConfidence === "high" && matchedMarket?.probability !== undefined
      ? matchedMarket.probability
      : trade.price ?? 0);
  const marketProbPct = (displayProbability * 100).toFixed(1);
  const probPct = (price * 100).toFixed(1);
  const size = trade.size;
  const shares = price > 0 ? size / price : 0;
  const payout = shares;
  const profit = payout - size;
  const profitPct = size > 0 ? ((profit / size) * 100).toFixed(1) : "0";
  const multiplier = price > 0 ? (1 / price).toFixed(1) : "—";
  const salaryWeeks = Math.round(size / US_WEEKLY_WAGE);
  const sizeMultiple = (size / MIN_WHALE_THRESHOLD).toFixed(1);
  const topPercent = getTopPercentTier(size);
  const impliedProb = Math.min(
    (displayProbability || trade.price) + 0.1,
    0.99
  );
  const whaleEv = impliedProb * payout - size;
  const avgBars = Math.min(10, Math.max(1, Math.round(MIN_WHALE_THRESHOLD / BAR_UNIT)));
  const tradeBars = Math.min(10, Math.max(1, Math.round(size / BAR_UNIT)));
  const volumeContext = matchedMarket
    ? getMarketVolumeContext(size, matchedMarket.volume)
    : null;
  const plainBet = getPlainEnglishBet(trade);
  const oddsComparison = getOddsComparison(displayProbability);
  const timingAnalysis = getTimingAnalysis(trade.timestamp);

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/"
        className="mb-6 inline-block text-sm text-pulse-muted transition-colors hover:text-white"
      >
        ← Back to Dashboard
      </Link>

      {/* SHOULD I COPY THIS BET */}
      <CopyBetSignal
        trade={trade}
        currentProbability={liveMarketPrice ?? trade.price}
        matchedMarket={matchedMarket}
        proxyWallet={displayWallet}
        walletUnavailable={walletResolutionFailed}
      />

      {tradeEvInput && (
        <CrossMarketEvBadge
          trade={tradeEvInput}
          index={evIndex}
          className="mb-8"
        />
      )}

      {/* SECTION 1: WHALE IDENTITY */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">🐋 Whale Identity</h2>
          <BookmarkTraderButton
            wallet={displayWallet}
            txHash={trade.transactionHash}
            assetId={trade.assetId}
            trade={trade}
          />
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                Proxy Wallet
              </p>
              {displayWallet && (
                <span className="text-[10px] text-slate-500">
                  Star to follow this trader
                </span>
              )}
            </div>
            {displayWallet ? (
              <>
                <p className="font-mono text-lg font-semibold text-white">
                  {displayWallet.slice(0, 6)}…{displayWallet.slice(-4)}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-slate-500">
                  {displayWallet}
                </p>
                <Link
                  href={`/traders/${encodeURIComponent(displayWallet)}/history`}
                  className="mt-3 inline-block text-sm font-medium text-pulse-accent hover:underline"
                >
                  View full trade history →
                </Link>
              </>
            ) : walletResolutionFailed ? (
              <p className="text-sm text-slate-400">
                Wallet could not be resolved for this trade yet.
              </p>
            ) : (
              <p className="text-sm text-slate-400 animate-pulse">
                Resolving wallet…
              </p>
            )}
            <a
              href={`https://polygonscan.com/tx/${trade.transactionHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm text-pulse-accent hover:underline"
            >
              View trade on blockchain →
            </a>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              Every Polymarket trade is tied to a proxy wallet. This is the
              address we use for track record and copy-signal analysis.
            </p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
              Trade Timestamp
            </p>
            <p className="text-lg font-semibold text-white">
              {getFullDate(trade.timestamp)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              UTC: {getUtcString(trade.timestamp)}
            </p>
            <p className="mt-1 text-sm text-pulse-accent">
              {getTimeAgo(trade.timestamp)}
            </p>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              The exact moment this whale pulled the trigger. Timing matters —
              trades right before major news often signal inside knowledge.
            </p>
          </div>
        </div>
      </section>

      <WhaleTrackRecord
        proxyWallet={displayWallet}
        walletUnavailable={walletResolutionFailed}
        entryPrice={trade.price}
        currentPrice={liveMarketPrice}
        betSize={size}
        marketsLoading={marketsLoading}
        marketMatched={!!matchedMarket}
        marketClosed={matchedMarket?.active === false}
      />

      {/* SECTION 2: WHAT HAPPENED */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          📖 What Happened — In Plain English
        </h2>
        <div className="space-y-3 text-sm leading-relaxed text-slate-300">
          <p>
            At {getTimeAgo(trade.timestamp)}, someone placed a{" "}
            <strong className="text-white">{formatDollars(size)}</strong>{" "}
            {trade.side === "SELL" ? "sell order on" : "bet that"}{" "}
            <strong className="text-white">{trade.outcome}</strong> on &ldquo;
            {trade.title}&rdquo;.
          </p>
          <p>
            They paid <strong className="text-white">{priceCents}¢</strong> per
            share, which means they{" "}
            {trade.side === "SELL" ? "sold" : "bought"}{" "}
            <strong className="text-white">
              {Math.round(shares).toLocaleString()}
            </strong>{" "}
            shares total.
          </p>
          <p>
            In simple terms:{" "}
            {trade.side === "SELL" ? (
              <>
                they&apos;re <strong className="text-white">exiting</strong> a
                position on this market.
              </>
            ) : (
              <>
                they&apos;re betting{" "}
                <strong className="text-white">{formatDollars(size)}</strong>{" "}
                that <strong className="text-white">{plainBet}</strong>.
              </>
            )}
          </p>
          {trade.side === "BUY" && (
            <p>
              If they&apos;re right, they&apos;ll collect{" "}
              <strong className="text-pulse-yes">{formatDollars(payout)}</strong>{" "}
              — a profit of{" "}
              <strong className="text-pulse-yes">{formatDollars(profit)}</strong>{" "}
              ({profitPct}% return). If they&apos;re wrong, they lose their
              entire {formatDollars(size)}.
            </p>
          )}
        </div>
      </section>

      {/* SECTION 3: MONEY MATH */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          💰 Breaking Down the Money
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <StatBox
            value={formatDollars(size)}
            label="Money at stake"
            explain={`This is real money on the line. ${formatDollars(size)} is roughly ${salaryWeeks} weeks of average US salary. This person is serious.`}
          />
          <StatBox
            value={`${priceCents}¢ per share`}
            label="Cost per share"
            explain={`Each share costs ${priceCents}¢. If the market resolves YES, each share pays $1.00. That's a ${multiplier}x return on each dollar spent.`}
          />
          <StatBox
            value={`${Math.round(shares).toLocaleString()} shares`}
            label="Shares purchased"
            explain={`Like buying ${Math.round(shares).toLocaleString()} lottery tickets that each pay $1 if you win. The more shares, the bigger the position.`}
          />
          <StatBox
            value={formatDollars(payout)}
            label="If they win"
            valueClassName="text-pulse-yes"
            explain={`This is what they collect if correct. That's a ${formatDollars(profit)} profit on a ${formatDollars(size)} bet — a ${profitPct}% return if the market resolves YES.`}
          />
        </div>
      </section>

      {/* SECTION 4: PROBABILITY */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🎯 What Does {marketProbPct}% Actually Mean?
        </h2>
        <p className="mb-4 text-sm text-slate-300">
          {marketProbPct}% implied probability — money-weighted, not a poll of
          opinions.
        </p>
        <div className="mb-2 h-3 overflow-hidden rounded-full bg-slate-700">
          <div
            className="h-full rounded-full bg-pulse-accent"
            style={{ width: `${Math.min(100, displayProbability * 100)}%` }}
          />
        </div>
        <p className="mb-4 text-sm text-slate-400">
          {formatImpliedProbabilitySummary(displayProbability)}
        </p>
        <div className="mb-4 rounded-lg bg-slate-900/60 p-4 text-sm text-slate-300">
          <p className="mb-1 font-medium text-white">Odds comparison</p>
          <p>
            {marketProbPct}% is roughly the same odds as:{" "}
            <strong className="text-white">{oddsComparison}</strong>
          </p>
        </div>
        <div className="text-sm leading-relaxed text-slate-300">
          <p className="mb-3">
            {trade.side === "SELL"
              ? `By selling, the whale is signaling they believe the TRUE probability is LOWER than ${(displayProbability * 100).toFixed(1)}%. By selling, they think this outcome is LESS likely than the market suggests.`
              : isNoBet
                ? `By betting NO, the whale believes this is LESS likely than the market suggests. They think the probability should be LOWER than ${(displayProbability * 100).toFixed(1)}%.`
                : `By placing this bet, the whale is signaling they believe the TRUE probability is HIGHER than ${(displayProbability * 100).toFixed(1)}%. They think the market is underpricing this outcome.`}
          </p>
          {trade.side === "SELL" ? (
            <p>
              This whale is EXITING — EV analysis applies to buyers, not
              sellers. The seller believes the current{" "}
              {(displayProbability * 100).toFixed(1)}% probability is too HIGH.
            </p>
          ) : isNoBet ? (
            <p>
              This whale bet NO at {priceCents}¢ — they expect this outcome to
              be LESS likely than {marketProbPct}%. If wrong, they lose{" "}
              {formatDollars(size)}.
            </p>
          ) : (
            <>
              <p>
                If they think the real probability is even{" "}
                {(impliedProb * 100).toFixed(0)}%, this bet has positive
                expected value:
              </p>
              <p className="mt-2 font-mono text-slate-200">
                EV = ({(impliedProb * 100).toFixed(0)}% × {formatDollars(payout)}
                ) - {formatDollars(size)} ={" "}
                <span
                  className={whaleEv >= 0 ? "text-pulse-yes" : "text-red-400"}
                >
                  {whaleEv >= 0 ? "+" : ""}
                  {formatDollars(whaleEv)}
                </span>
              </p>
            </>
          )}
        </div>
      </section>

      {/* SECTION 5: CONVICTION SIGNALS */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🔍 Reading the Signals
        </h2>
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-3 text-sm font-medium text-white">
              Signal 1 — Position Size Context
            </p>
            <BarComparison
              label="Average whale trade"
              amount={`$${MIN_WHALE_THRESHOLD}`}
              filled={avgBars}
            />
            <BarComparison
              label="This trade"
              amount={formatDollars(size)}
              filled={tradeBars}
            />
            <p className="mt-2 text-sm text-slate-400">
              {formatDollars(size)} is {sizeMultiple}x larger than the
              minimum whale threshold (${MIN_WHALE_THRESHOLD}). This puts it in
              the top {topPercent}% of all trades on this platform.
            </p>
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-2 text-sm font-medium text-white">
              Signal 2 — Price Entry Analysis
            </p>
            <p className="text-sm leading-relaxed text-slate-400">
              {trade.side === "SELL" ? (
                <>
                  This whale SOLD at {(trade.price * 100).toFixed(1)}¢. Selling
                  at a low price means they&apos;re exiting a position they
                  previously bought, likely at a higher price. They may be
                  cutting losses or believe the probability will drop further.
                </>
              ) : price < 0.5 ? (
                <>
                  This whale bought at {(trade.price * 100).toFixed(1)}¢.
                  Buying below 50¢ means betting on an UNDERDOG. Underdogs pay
                  more if they win ({multiplier}x here) but lose more often.
                  Smart money often bets underdogs when they believe the market
                  is mispriced. The question is: does this whale know something
                  the market doesn&apos;t?
                </>
              ) : (
                <>
                  This whale bought at {(trade.price * 100).toFixed(1)}¢.
                  Buying above 50¢ means betting on the FAVORITE. Lower payout
                  but higher probability of winning.
                </>
              )}
            </p>
          </div>

          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-2 text-sm font-medium text-white">
              Signal 3 — BUY vs SELL Meaning
            </p>
            <p className="text-sm leading-relaxed text-slate-400">
              {trade.side === "BUY"
                ? "A BUY order means this whale is OPENING a new position — they're putting fresh money in. This is more meaningful than a SELL, which could just be someone cashing out an existing bet."
                : "A SELL order means this whale is CLOSING or reducing an existing position. They might be taking profit, cutting losses, or hedging. Less bullish than a BUY signal."}
            </p>
          </div>

          {volumeContext && matchedMarket ? (
            <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
              <p className="mb-2 text-sm font-medium text-white">
                Signal 4 — Market Significance
              </p>
              <p className="text-sm leading-relaxed text-slate-400">
                This market has {formatVol(matchedMarket.volume)} in
                total trading. This whale&apos;s {formatDollars(size)}{" "}
                represents {volumeContext.pct.toFixed(2)}% of all money bet on
                this market. {volumeContext.message}
              </p>
            </div>
          ) : marketsLoading ? (
            <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
              <p className="mb-2 text-sm font-medium text-white">
                Signal 4 — Market Significance
              </p>
              <EnrichmentSkeleton rows={2} />
            </div>
          ) : null}

          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-2 text-sm font-medium text-white">
              Signal 5 — Timing Analysis
            </p>
            <p className="text-sm leading-relaxed text-slate-400">
              {timingAnalysis}
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 6: NEARBY TRADES */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🔗 Other Activity at the Same Time
        </h2>
        {filteredNearby.length === 0 ? (
          <p className="text-sm text-slate-400">
            All other nearby trades were under ${NEARBY_MIN_SIZE} — likely
            unrelated retail activity. Focus on the main trade above.
          </p>
        ) : (
          <>
            <div className="space-y-3">
              {visibleNearby.map((t) => (
                <div
                  key={t.id}
                  className="rounded-xl border border-slate-700 bg-slate-900/50 p-4"
                >
                  <p className="font-medium text-white">{t.title}</p>
                  <p className="mb-2 text-sm text-slate-400">
                    {t.side} · ${Math.round(t.size).toLocaleString()} ·{" "}
                    {(t.price * 100).toFixed(1)}¢
                  </p>
                  <p className="text-xs italic text-slate-500">
                    A separate ${Math.round(t.size).toLocaleString()} bet placed
                    at nearly the same time. Could be the same wallet
                    diversifying, or a different trader entirely.
                  </p>
                </div>
              ))}
            </div>
            {filteredNearby.length > 5 && (
              <button
                type="button"
                onClick={() => setShowAllNearby((v) => !v)}
                className="mt-4 text-sm text-pulse-accent hover:underline"
              >
                {showAllNearby
                  ? "Show less"
                  : `Show ${filteredNearby.length - 5} more`}
              </button>
            )}
          </>
        )}
      </section>

      {/* SECTION 8: DISCLAIMER */}
      <section className="rounded-xl border border-slate-700 bg-slate-900/30 p-6">
        <h2 className="mb-4 text-sm font-semibold text-slate-400">
          ⚠️ Important: What We Don&apos;t Know
        </h2>
        <p className="mb-3 text-sm text-slate-400">
          Prediction market data has real limits. Here&apos;s what we CAN&apos;T
          tell you:
        </p>
        <ul className="mb-4 space-y-2 text-sm text-slate-500">
          <li>❓ Who this whale is — wallets are anonymous</li>
          <li>
            ❓ Why they placed this bet — no explanation is ever given
          </li>
          <li>
            ❓ Whether they have inside information — we can&apos;t verify this
          </li>
          <li>
            ❓ Their full history — stats are based on the last 50 closed
            positions only
          </li>
          <li>
            ❓ Whether this is their only position — they may be hedging a larger
            bet elsewhere
          </li>
        </ul>
        <p className="text-xs text-slate-500">
          Use this analysis as a starting point for your own research, never as
          the final word.
        </p>
      </section>
    </main>
  );
}
