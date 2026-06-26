"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import KalshiCandlestickChart from "@/components/KalshiCandlestickChart";
import KalshiAnonymousTradePanel from "@/components/KalshiMarketFlowPanel";
import KalshiMarketMetrics from "@/components/KalshiMarketMetrics";
import KalshiOrderBookDepth from "@/components/KalshiOrderBookDepth";
import LoadErrorCard from "@/components/LoadErrorCard";
import TradeDetailSkeleton, {
  EnrichmentSkeleton,
} from "@/components/TradeDetailSkeleton";
import {
  fetchWithTimeout,
  isFetchTimeoutError,
} from "@/lib/fetchWithTimeout";
import type {
  KalshiCandlestick,
  KalshiMarketDetail,
  KalshiMarketFlow,
  KalshiOrderBook,
  KalshiTradeDetail,
} from "@/lib/kalshiDetail";
import { kalshiYesMidFromMarket } from "@/lib/kalshiDetail";
import {
  initialKalshiTradeFromStash,
  peekStashedKalshiTrade,
} from "@/lib/tradeNavigationStore";
import { useCrossMarketEvIndex } from "@/lib/useCrossMarketEvIndex";
import { getFullDate, getTimeAgo, getUtcString } from "@/lib/time";
import {
  formatImpliedProbabilitySummary,
  getPlainEnglishOutcomeLabel,
  getPriceAnalysis,
  getQuickTakeForTrade,
  getTradeClass,
  getTradeDirectionInsight,
  getTradeTierIndex,
  TIER_COLOR_CLASSES,
  TIER_RANGES,
  TRADE_TIERS,
} from "@/lib/tradeDetail";

interface TradeDetailPayload {
  trade: KalshiTradeDetail;
  market: KalshiMarketDetail | null;
  orderbook: KalshiOrderBook | null;
  candlesticks: KalshiCandlestick[];
  marketFlow: KalshiMarketFlow | null;
  relatedTrades: KalshiTradeDetail[];
}

interface MarketEnrichment {
  market: KalshiMarketDetail | null;
  orderbook: KalshiOrderBook | null;
  candlesticks: KalshiCandlestick[];
  marketFlow: KalshiMarketFlow | null;
  relatedTrades: KalshiTradeDetail[];
}

function SizeBar({ filled }: { filled: number }) {
  return (
    <div className="flex flex-1 gap-0.5">
      {Array.from({ length: 10 }).map((_, i) => (
        <div
          key={i}
          className={`h-2 flex-1 rounded-sm ${
            i < filled ? "bg-pulse-accent" : "bg-slate-700"
          }`}
        />
      ))}
    </div>
  );
}

function formatKalshiDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

function emptyEnrichment(trade: KalshiTradeDetail): TradeDetailPayload {
  return {
    trade,
    market: null,
    orderbook: null,
    candlesticks: [],
    marketFlow: null,
    relatedTrades: [],
  };
}

export default function KalshiTradeDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const tradeId =
    typeof params.id === "string" ? decodeURIComponent(params.id) : "";
  const tickerHint = searchParams.get("ticker") ?? undefined;

  const [payload, setPayload] = useState<TradeDetailPayload | null>(() => {
    const stashed = initialKalshiTradeFromStash(tradeId);
    return stashed ? emptyEnrichment(stashed) : null;
  });
  const [loading, setLoading] = useState(() => !initialKalshiTradeFromStash(tradeId));
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [enriching, setEnriching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { index: evIndex } = useCrossMarketEvIndex();

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

    const enrichFromTicker = async (
      trade: KalshiTradeDetail,
      ticker: string
    ) => {
      setEnriching(true);
      try {
        const qs = new URLSearchParams({
          ticker,
          exclude_trade_id: trade.tradeId,
        });
        const res = await fetchWithTimeout(
          `/api/kalshi/market-enrich?${qs.toString()}`,
          { signal }
        );
        if (signal.aborted || !res.ok) return;

        const data = (await res.json()) as MarketEnrichment;
        if (signal.aborted) return;

        setPayload({
          trade,
          market: data.market,
          orderbook: data.orderbook,
          candlesticks: data.candlesticks,
          marketFlow: data.marketFlow,
          relatedTrades: data.relatedTrades,
        });
      } catch {
        // Enrichment is optional — stashed trade stays visible
      } finally {
        if (!signal.aborted) setEnriching(false);
      }
    };

    if (stashed) {
      setPayload(emptyEnrichment(stashed.trade));
      setLoading(false);
      void enrichFromTicker(stashed.trade, stashed.ticker);
      return () => controller.abort();
    }

    setLoading(true);

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
          const stillStashed = peekStashedKalshiTrade(tradeId);
          if (stillStashed) {
            setPayload(emptyEnrichment(stillStashed.trade));
            setNotFound(false);
            setLoading(false);
            void enrichFromTicker(stillStashed.trade, stillStashed.ticker);
            return;
          }
          setNotFound(true);
          setPayload(null);
          setLoading(false);
          return;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = (await res.json()) as TradeDetailPayload;
        if (signal.aborted) return;
        setPayload(data);
        setNotFound(false);
        setLoading(false);
      } catch (err) {
        if (signal.aborted) return;
        setLoadError(
          isFetchTimeoutError(err)
            ? "Kalshi trade data timed out after 8 seconds."
            : "Could not load Kalshi trade data."
        );
        setPayload(null);
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [tradeId, tickerHint, reloadKey]);

  const trade = payload?.trade ?? null;
  const market = payload?.market;
  const orderbook = payload?.orderbook;
  const candlesticks = payload?.candlesticks ?? [];
  const marketFlow = payload?.marketFlow;
  const relatedTrades = payload?.relatedTrades ?? [];

  const currentPrice = useMemo(() => {
    if (market) {
      const mid = kalshiYesMidFromMarket(market);
      if (mid != null) return mid;
    }
    return trade?.price ?? 0;
  }, [market, trade?.price]);

  if (loading && !trade) {
    return <TradeDetailSkeleton />;
  }

  if (loadError && !trade) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Dashboard
        </Link>
        <LoadErrorCard message={loadError} onRetry={retryLoad} />
      </main>
    );
  }

  if (notFound || !trade) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Dashboard
        </Link>
        <p className="mt-8 text-red-400">Kalshi trade not found.</p>
      </main>
    );
  }

  const price = trade.price;
  const priceCents = (price * 100).toFixed(1);
  const probPct = (price * 100).toFixed(1);
  const size = trade.usdNotional;
  const contracts = trade.count;
  const payout = contracts;
  const profitPct =
    price > 0 ? ((1 / price - 1) * 100).toFixed(1) : "0";
  const multiplier = price > 0 ? (1 / price).toFixed(1) : "—";
  const tradeClass = getTradeClass(size);
  const activeTier = getTradeTierIndex(size);
  const plainOutcome = getPlainEnglishOutcomeLabel(trade.outcome);
  const priceAnalysis = getPriceAnalysis(price);
  const quickTake = getQuickTakeForTrade(size, trade.side, price);

  const tradePricePct = price * 100;
  const currentProbPct = currentPrice * 100;
  const delta = currentProbPct - tradePricePct;
  const directionInsight = getTradeDirectionInsight(delta, trade.side);

  const liveContracts = price > 0 ? size / price : 0;
  const liveValue =
    trade.side === "BUY"
      ? liveContracts * currentPrice
      : size;
  const livePnl =
    trade.side === "BUY"
      ? liveValue - size
      : size - liveContracts * currentPrice;

  const marketLoading = (loading || enriching) && !market;
  const kalshiHref =
    market?.webUrl ??
    `https://kalshi.com/markets/${trade.ticker.split("-")[0].toLowerCase()}`;

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/"
        className="mb-6 inline-block text-sm text-pulse-muted transition-colors hover:text-white"
      >
        ← Back to Dashboard
      </Link>

      <div className="mb-4 flex items-center gap-2">
        <span className="rounded bg-teal-900/40 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-teal-300">
          Kalshi
        </span>
        {trade.isBlockTrade && (
          <span className="rounded bg-purple-900/40 px-2 py-0.5 text-xs text-purple-300">
            Block trade
          </span>
        )}
      </div>

      {/* SECTION 1: TRADE IDENTITY */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          📋 Trade Identity
        </h2>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
              Trade ID
            </p>
            <p className="font-mono text-sm font-semibold text-white">
              {trade.tradeId}
            </p>
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-slate-400">
              Market ticker
            </p>
            <p className="font-mono text-sm text-teal-300">{trade.ticker}</p>
            <a
              href={kalshiHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm text-pulse-accent hover:underline"
            >
              View on Kalshi →
            </a>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              Kalshi is a CFTC-regulated exchange. Public trade data includes
              price and size but never trader identity.
            </p>
          </div>
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
              Timestamp
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
              The exact moment this trade executed. Kalshi matches orders
              instantly on their regulated exchange — trades are final the moment
              they fill.
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 2: WHAT HAPPENED */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          📖 What This Trade Means
        </h2>
        <div className="space-y-3 text-sm leading-relaxed text-slate-300">
          {trade.side === "BUY" ? (
            <>
              <p>
                At {getTimeAgo(trade.timestamp)}, someone spent{" "}
                <strong className="text-white">
                  ${size.toLocaleString()}
                </strong>{" "}
                to bet that <strong className="text-white">{trade.outcome}</strong>{" "}
                on &ldquo;{trade.title}&rdquo;.
              </p>
              <p>
                They paid <strong className="text-white">{priceCents}¢</strong>{" "}
                per contract, getting{" "}
                <strong className="text-white">
                  {contracts.toLocaleString()}
                </strong>{" "}
                contracts in return.
              </p>
              <p>
                <strong className="text-white">Translation:</strong> They believe{" "}
                {plainOutcome}. If correct, their $
                {size.toLocaleString()} becomes{" "}
                <strong className="text-pulse-yes">
                  ${payout.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </strong>{" "}
                — a {profitPct}% profit. If wrong, they lose their $
                {size.toLocaleString()} entirely.
              </p>
            </>
          ) : (
            <>
              <p>
                At {getTimeAgo(trade.timestamp)}, someone sold{" "}
                <strong className="text-white">
                  {contracts.toLocaleString()}
                </strong>{" "}
                contracts on &ldquo;{trade.title}&rdquo; for{" "}
                <strong className="text-white">
                  ${size.toLocaleString()}
                </strong>{" "}
                total.
              </p>
              <p>
                They received <strong className="text-white">{priceCents}¢</strong>{" "}
                per contract.
              </p>
              <p>
                <strong className="text-white">Translation:</strong> They are
                EXITING their position on{" "}
                <strong className="text-white">{trade.outcome}</strong>. This
                could mean:
              </p>
              <ul className="list-inside list-disc space-y-1 text-slate-400">
                <li>They&apos;re locking in profit after the price moved up</li>
                <li>They&apos;re cutting losses before it gets worse</li>
                <li>They&apos;re freeing up cash for another trade</li>
              </ul>
            </>
          )}
        </div>
      </section>

      <KalshiMarketMetrics
        trade={trade}
        market={market ?? null}
        orderbook={orderbook ?? null}
        marketFlow={marketFlow ?? null}
        evIndex={evIndex}
        enriching={enriching}
      />

      {/* SECTION 3: LIVE PRICE CHART */}
      <section className="mb-6 rounded-xl bg-slate-800 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">
            📈 Live Price Chart
          </h2>
          <span className="text-xs text-slate-400">
            Market probability over time
          </span>
        </div>

        <p className="mb-4 text-sm text-slate-300">
          Current market probability:{" "}
          {marketLoading ? (
            <span className="inline-block h-4 w-12 animate-pulse rounded bg-slate-700 align-middle" />
          ) : (
            <strong className="text-white">{currentProbPct.toFixed(1)}%</strong>
          )}
          {" "}(was <strong className="text-white">{tradePricePct.toFixed(1)}%</strong>{" "}
          when this trade was placed)
        </p>

        {candlesticks.length === 0 && marketLoading ? (
          <EnrichmentSkeleton rows={4} />
        ) : (
          <KalshiCandlestickChart
            candlesticks={candlesticks}
            tradePrice={trade.price}
            tradeTimestamp={trade.timestamp}
            currentPrice={currentPrice}
          />
        )}

        <div className="mt-4 space-y-2">
          <p
            className={`text-sm font-medium ${
              delta > 0
                ? "text-green-400"
                : delta < 0
                  ? "text-red-400"
                  : "text-slate-400"
            }`}
          >
            {delta > 0 ? "↑" : delta < 0 ? "↓" : "—"}{" "}
            {delta > 0 ? "+" : ""}
            {delta.toFixed(1)}% since this trade
          </p>
          {directionInsight && (
            <p className={`text-sm ${directionInsight.className}`}>
              {directionInsight.text}
            </p>
          )}
          {trade.side === "BUY" && (
            <p className="text-xs text-slate-500">
              Estimated position value now: ${liveValue.toFixed(2)} (
              {livePnl >= 0 ? "+" : ""}
              ${livePnl.toFixed(2)} vs entry)
            </p>
          )}
        </div>
      </section>

      {/* SECTION 4: TRADE SIZE */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          💰 How Big Is This Trade?
        </h2>
        <div className="mb-6 text-center">
          <p className="mb-2 text-4xl">{tradeClass.emoji}</p>
          <p className="mb-2 text-xl font-bold text-white">
            {tradeClass.label}
          </p>
          <span
            className={`inline-block rounded-full border px-3 py-1 text-xs font-medium ${TIER_COLOR_CLASSES[tradeClass.color]}`}
          >
            {tradeClass.percentile}
          </span>
          <p className="mx-auto mt-4 max-w-lg text-sm text-slate-400">
            {tradeClass.description}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            This trade is in the {tradeClass.percentile} of all trades
          </p>
        </div>
        <div className="space-y-2">
          {TIER_RANGES.map((tier, i) => {
            const tierData = TRADE_TIERS[i];
            const isActive = i === activeTier;
            return (
              <div
                key={tier.label}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-xs ${
                  isActive
                    ? "border border-pulse-accent/50 bg-pulse-accent/10"
                    : "border border-transparent"
                }`}
              >
                <span className="w-16 shrink-0 text-slate-400">
                  {tier.emoji} {tier.label}
                </span>
                <span className="w-20 shrink-0 text-slate-500">
                  {tier.range}
                </span>
                <SizeBar filled={tierData.barFill} />
              </div>
            );
          })}
        </div>
      </section>

      {/* SECTION 5: PRICE ANALYSIS */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🎯 What The Price Tells Us
        </h2>
        <p className="mb-4 text-sm text-slate-300">
          Price paid: <strong className="text-white">{priceCents}¢</strong>
        </p>
        <p className="mb-4 text-sm leading-relaxed text-slate-300">
          Each contract costs {priceCents}¢ and pays $1.00 if correct. That&apos;s
          a <strong className="text-white">{multiplier}x</strong> return on each
          contract.
        </p>
        <p className="mb-6 rounded-lg bg-slate-900/60 p-4 text-sm text-slate-300">
          {priceAnalysis}
        </p>
        <p className="mb-4 text-sm text-slate-300">
          {priceCents}¢ per contract ={" "}
          <strong className="text-white">{probPct}%</strong> implied probability
          — money-weighted, not a poll of opinions.
        </p>
        <div className="mb-2 h-3 overflow-hidden rounded-full bg-slate-700">
          <div
            className="h-full rounded-full bg-pulse-accent"
            style={{ width: `${Math.min(100, price * 100)}%` }}
          />
        </div>
        <p className="text-sm text-slate-400">
          {formatImpliedProbabilitySummary(price)}
        </p>
      </section>

      {/* SECTION 6: BUY vs SELL */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          📈 Understanding This Order Type
        </h2>
        <div className="whitespace-pre-line text-sm leading-relaxed text-slate-300">
          {trade.side === "BUY" ? (
            <>
              <p className="mb-3 font-medium text-pulse-yes">
                🟢 This is a BUY order — someone is opening or adding to a
                position.
              </p>
              <p className="mb-2 font-medium text-white">What it signals:</p>
              <p className="mb-3 text-slate-400">
                → They believe the probability is HIGHER than what the market
                shows{"\n"}→ They&apos;re willing to put real money behind that
                belief{"\n"}→ Fresh capital entering the market
              </p>
              <p className="mb-2 font-medium text-white">Why this matters:</p>
              <p className="text-slate-400">
                When smart money BUYs, it pushes the price up — the probability
                goes higher. If many traders follow, this could become a
                self-fulfilling signal.{"\n\n"}
                Real example: If 10 whales all BUY YES on the same market, the
                price moves from 30% to 45%. That repricing reflects new money
                entering at higher prices — not a headcount of who changed their
                mind.
              </p>
            </>
          ) : (
            <>
              <p className="mb-3 font-medium text-red-400">
                🔴 This is a SELL order — someone is closing or reducing a
                position.
              </p>
              <p className="mb-2 font-medium text-white">What it signals:</p>
              <p className="mb-3 text-slate-400">
                → They&apos;re cashing out — could be profit OR loss{"\n"}→ They
                no longer want exposure to this outcome{"\n"}→ Capital leaving
                the market
              </p>
              <p className="mb-2 font-medium text-white">
                Three possible reasons:
              </p>
              <p className="mb-3 text-slate-400">
                1. Taking profit: Price moved in their favor, they&apos;re locking
                in gains ✅{"\n"}
                2. Cutting losses: Price moved against them, they&apos;re
                stopping the bleeding ⚠️{"\n"}
                3. Hedging: They have a related position elsewhere and are
                balancing risk 🔄
              </p>
              <p className="mb-2 font-medium text-white">
                Why sells are tricky:
              </p>
              <p className="text-slate-400">
                A SELL tells you someone is leaving, but not WHY. A whale selling
                could mean they think the trade went wrong — or it could mean
                they made so much profit they&apos;re satisfied. Context matters.
              </p>
            </>
          )}
        </div>
        <div className="mt-6 grid gap-4 border-t border-slate-700 pt-6 sm:grid-cols-2 text-sm text-slate-300">
          <div>
            <p className="text-xs text-slate-500">Taker side</p>
            <p className="font-medium text-white capitalize">
              {trade.takerSide}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Outcome</p>
            <p className="font-medium text-white">{trade.outcome}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Book side</p>
            <p className="font-medium text-white">
              {trade.takerBookSide === "bid" ? "Bid (buying)" : "Ask (selling)"}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Action</p>
            <p
              className={`font-medium ${
                trade.side === "BUY" ? "text-green-400" : "text-red-400"
              }`}
            >
              {trade.side}
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 7: MARKET CONTEXT + ORDER BOOK */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🌍 Market & Order Book
        </h2>
        {marketLoading ? (
          <EnrichmentSkeleton rows={5} />
        ) : market ? (
          <>
            <div className="rounded-xl border border-pulse-border bg-pulse-card p-4">
              <h3 className="mb-3 text-sm font-medium text-white">
                {market.title}
              </h3>
              <Link
                href={`/markets/${encodeURIComponent(market.ticker)}`}
                className="inline-block text-sm text-pulse-accent hover:underline"
              >
                View full market →
              </Link>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <p className="text-xs text-pulse-muted">Yes bid / ask</p>
                <p className="font-semibold text-green-400">
                  {market.yesBid != null
                    ? `${(market.yesBid * 100).toFixed(1)}¢`
                    : "—"}{" "}
                  /{" "}
                  {market.yesAsk != null
                    ? `${(market.yesAsk * 100).toFixed(1)}¢`
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-pulse-muted">No bid / ask</p>
                <p className="font-semibold text-red-400">
                  {market.noBid != null
                    ? `${(market.noBid * 100).toFixed(1)}¢`
                    : "—"}{" "}
                  /{" "}
                  {market.noAsk != null
                    ? `${(market.noAsk * 100).toFixed(1)}¢`
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-pulse-muted">Status</p>
                <p className="font-semibold capitalize text-white">
                  {market.status || "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-pulse-muted">Close</p>
                <p className="text-sm text-white">
                  {formatKalshiDate(market.closeTime)}
                </p>
              </div>
            </div>

            {market.rulesPrimary && (
              <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900/50 p-4">
                <p className="mb-2 text-xs font-medium uppercase text-slate-500">
                  Resolution rules
                </p>
                <p className="text-sm leading-relaxed text-slate-300">
                  {market.rulesPrimary}
                </p>
                {market.rulesSecondary && (
                  <p className="mt-3 text-xs leading-relaxed text-slate-500">
                    {market.rulesSecondary}
                  </p>
                )}
              </div>
            )}

            {orderbook ? (
              <div className="mt-6 border-t border-slate-700 pt-6">
                <h3 className="mb-3 text-sm font-medium text-slate-300">
                  Order book depth
                </h3>
                <KalshiOrderBookDepth orderbook={orderbook} />
              </div>
            ) : (
              <p className="mt-4 text-sm text-slate-500">
                Order book unavailable for this market.
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-400">
            Could not match this trade to a live market listing.
          </p>
        )}
      </section>

      {/* SECTION 8: BEGINNER LESSONS */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🎓 Beginner Trading Lessons From This Trade
        </h2>
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-2 text-sm font-medium text-white">
              Lesson 1 — About position sizing
            </p>
            <p className="text-sm leading-relaxed text-slate-400">
              This trader bet ${size.toLocaleString()}. As a beginner, a good
              rule is to never bet more than 1-5% of your total bankroll on a
              single market. If your practice balance is $1,000, that means
              $10-50 per trade. This keeps you in the game even when you&apos;re
              wrong.
            </p>
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-2 text-sm font-medium text-white">
              Lesson 2 — About probability
            </p>
            <p className="whitespace-pre-line text-sm leading-relaxed text-slate-400">
              {formatImpliedProbabilitySummary(price)} — that reflects how much
              money traders are willing to risk, not how many people voted Yes.
              {"\n\n"}
              If the market is fairly priced at {probPct}%, you&apos;d expect to
              break even by winning about {probPct}% of identical bets over many
              trials. The edge question: do you think the true chance is higher
              or lower than {probPct}%?
            </p>
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-2 text-sm font-medium text-white">
              Lesson 3 — About regulated exchanges
            </p>
            <p className="whitespace-pre-line text-sm leading-relaxed text-slate-400">
              Every trade on Kalshi is recorded on a CFTC-regulated exchange.
              This means:{"\n"}✅ Price and size are fully transparent{"\n"}✅
              Trades cannot be hidden or altered after execution{"\n"}✅ You can
              verify market activity independently{"\n\n"}
              Kalshi deliberately does not reveal trader identity — unlike
              Polymarket&apos;s on-chain wallets, you see what traded but not
              who traded. That transparency-with-privacy is a trade-off worth
              understanding.
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 10: QUICK VERDICT */}
      <section className="mb-8 rounded-xl border border-slate-600 bg-slate-700 p-5">
        <h2 className="mb-3 text-lg font-semibold text-white">⚡ Quick Take</h2>
        <p className="text-sm font-medium leading-relaxed text-white">
          {quickTake}
        </p>
      </section>

      {/* SECTION 11: ANONYMOUS (replaces whale sections) */}
      <KalshiAnonymousTradePanel />

      {/* SECTION 12: RELATED TRADES */}
      {relatedTrades.length > 0 && (
        <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
          <h2 className="mb-4 text-lg font-semibold text-white">
            🔗 Other Activity at the Same Time
          </h2>
          <div className="space-y-3">
            {relatedTrades.slice(0, 8).map((t) => (
              <Link
                key={t.tradeId}
                href={`/trades/kalshi/${encodeURIComponent(t.tradeId)}?ticker=${encodeURIComponent(t.ticker)}`}
                className="block rounded-xl border border-slate-700 bg-slate-900/50 p-4 transition-colors hover:bg-slate-800"
              >
                <p className="font-medium text-white">{t.title}</p>
                <p className="text-sm text-slate-400">
                  {t.side} · ${Math.round(t.usdNotional).toLocaleString()} ·{" "}
                  {(t.price * 100).toFixed(1)}¢
                </p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <a
          href={kalshiHref}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full rounded-xl bg-teal-600 px-6 py-4 text-center text-lg font-semibold text-white transition-colors hover:bg-teal-500"
        >
          View this bet on Kalshi
        </a>
        <p className="mt-2 text-center text-xs text-slate-500">
          Opens the same Kalshi market page as the link above — place or
          research this contract on Kalshi.
        </p>
      </section>

      <p className="text-xs leading-relaxed text-slate-500">
        Trade data is for educational purposes only. Past trades do not predict
        future market movements. Never copy trades blindly.
      </p>
    </main>
  );
}
