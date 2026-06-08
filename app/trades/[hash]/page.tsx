"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MarketSummary, TradeSummary } from "@/lib/polymarket";
import { formatVolumeUsd } from "@/lib/polymarket";
import {
  findMarketForTrade,
  findRelatedTrades,
  findTradeByHash,
  truncateTxHash,
} from "@/lib/whaleProfile";
import { getFullDate, getTimeAgo, getUtcString } from "@/lib/time";
import {
  getPlainEnglishOutcome,
  getPriceAnalysis,
  getPriceMovementMessage,
  getQuickTake,
  getTradeClass,
  getTradeTierIndex,
  TIER_COLOR_CLASSES,
  TIER_RANGES,
  TRADE_TIERS,
} from "@/lib/tradeDetail";

const NEARBY_MIN_SIZE = 50;

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

export default function TradeDetailPage() {
  const params = useParams();
  const hash = typeof params.hash === "string" ? params.hash : "";

  const [trade, setTrade] = useState<TradeSummary | null>(null);
  const [relatedTrades, setRelatedTrades] = useState<TradeSummary[]>([]);
  const [matchedMarket, setMatchedMarket] = useState<MarketSummary | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [showAllNearby, setShowAllNearby] = useState(false);

  const loadTrade = useCallback(async () => {
    if (!hash) return;

    try {
      const [tradesRes, pmRes, piRes] = await Promise.all([
        fetch("/api/trades"),
        fetch("/api/markets"),
        fetch("/api/kalshi"),
      ]);

      const tradesData: { trades?: TradeSummary[] } = await tradesRes.json();
      const pmData: { markets?: MarketSummary[] } = await pmRes.json();
      const piData: { markets?: MarketSummary[] } = await piRes.json();

      const trades = tradesData.trades ?? [];
      const found = findTradeByHash(trades, hash);

      if (!found) {
        setNotFound(true);
        setTrade(null);
        return;
      }

      const allMarkets = [
        ...(pmData.markets ?? []),
        ...(piData.markets ?? []),
      ];

      setTrade(found);
      setRelatedTrades(findRelatedTrades(trades, found));
      setMatchedMarket(findMarketForTrade(found, allMarkets));
      setNotFound(false);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [hash]);

  useEffect(() => {
    setLoading(true);
    loadTrade();
  }, [loadTrade]);

  const filteredNearby = useMemo(() => {
    return relatedTrades
      .filter((t) => t.size >= NEARBY_MIN_SIZE)
      .sort((a, b) => b.size - a.size);
  }, [relatedTrades]);

  const visibleNearby = showAllNearby
    ? filteredNearby
    : filteredNearby.slice(0, 5);

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-pulse-muted animate-pulse">Loading trade details…</p>
      </main>
    );
  }

  if (notFound || !trade) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Dashboard
        </Link>
        <p className="mt-8 text-red-400">Trade not found.</p>
      </main>
    );
  }

  const price = trade.price;
  const priceCents = (price * 100).toFixed(1);
  const probPct = (price * 100).toFixed(1);
  const size = trade.size;
  const shares =
    price > 0 ? Number((size / price).toFixed(0)) : 0;
  const payout = price > 0 ? Number((size / price).toFixed(2)) : 0;
  const profit = price > 0 ? Number((size / price - size).toFixed(2)) : 0;
  const profitPct =
    price > 0 ? ((1 / price - 1) * 100).toFixed(1) : "0";
  const multiplier = price > 0 ? (1 / price).toFixed(1) : "—";
  const filledCircles = Math.round(price * 10);
  const tradeClass = getTradeClass(size);
  const activeTier = getTradeTierIndex(size);
  const plainOutcome = getPlainEnglishOutcome(trade);
  const priceAnalysis = getPriceAnalysis(price);
  const quickTake = getQuickTake(trade);

  const tradePricePct = price * 100;
  const currentProbPct = matchedMarket
    ? matchedMarket.probability * 100
    : null;
  const delta =
    currentProbPct != null ? currentProbPct - tradePricePct : 0;
  const priceMovedInFavor =
    trade.side === "BUY" ? delta > 0 : delta < 0;

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/"
        className="mb-6 inline-block text-sm text-pulse-muted transition-colors hover:text-white"
      >
        ← Back to Dashboard
      </Link>

      {/* SECTION 1: TRADE IDENTITY */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          📋 Trade Identity
        </h2>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
              Transaction Hash
            </p>
            <p className="font-mono text-lg font-semibold text-white">
              {truncateTxHash(trade.transactionHash)}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-slate-500">
              {trade.transactionHash}
            </p>
            <a
              href={`https://polygonscan.com/tx/${trade.transactionHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm text-pulse-accent hover:underline"
            >
              Verify on blockchain →
            </a>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              Every trade on Polymarket is recorded permanently on the Polygon
              blockchain. This means it can never be altered or deleted — full
              transparency.
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
              The exact moment this trade executed. On-chain trades are final the
              moment they&apos;re confirmed — usually within 2 seconds.
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
                per share, getting{" "}
                <strong className="text-white">
                  {shares.toLocaleString()}
                </strong>{" "}
                shares in return.
              </p>
              <p>
                <strong className="text-white">Translation:</strong> They believe{" "}
                {plainOutcome}. If correct, their $
                {size.toLocaleString()} becomes{" "}
                <strong className="text-pulse-yes">
                  ${payout.toLocaleString()}
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
                  {shares.toLocaleString()}
                </strong>{" "}
                shares on &ldquo;{trade.title}&rdquo; for{" "}
                <strong className="text-white">
                  ${size.toLocaleString()}
                </strong>{" "}
                total.
              </p>
              <p>
                They received <strong className="text-white">{priceCents}¢</strong>{" "}
                per share.
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

      {/* SECTION 3: TRADE SIZE CONTEXT */}
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

      {/* SECTION 4: PRICE ANALYSIS */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🎯 What The Price Tells Us
        </h2>
        <p className="mb-4 text-sm text-slate-300">
          Price paid: <strong className="text-white">{priceCents}¢</strong>
        </p>
        <p className="mb-4 text-sm leading-relaxed text-slate-300">
          Each share costs {priceCents}¢ and pays $1.00 if correct. That&apos;s
          a <strong className="text-white">{multiplier}x</strong> return on each
          share.
        </p>
        <p className="mb-6 rounded-lg bg-slate-900/60 p-4 text-sm text-slate-300">
          {priceAnalysis}
        </p>
        <p className="mb-3 text-sm text-slate-300">
          {priceCents}¢ per share ={" "}
          <strong className="text-white">{probPct}%</strong> implied probability
        </p>
        <div className="mb-2 flex gap-1">
          {Array.from({ length: 10 }).map((_, i) => (
            <span key={i} className="text-lg">
              {i < filledCircles ? "🟢" : "⬜"}
            </span>
          ))}
        </div>
        <p className="text-sm text-slate-400">
          {filledCircles} out of 10 people think this will happen
        </p>
      </section>

      {/* SECTION 5: BUY vs SELL */}
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
                price moves from 30% to 45%. That price change is the crowd
                updating their belief based on the whales&apos; actions.
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
      </section>

      {/* SECTION 6: MARKET CONTEXT */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🌍 The Market Being Traded
        </h2>
        {matchedMarket ? (
          <>
            <div className="rounded-xl border border-pulse-border bg-pulse-card p-4">
              <h3 className="mb-3 text-sm font-medium text-white">
                {matchedMarket.question}
              </h3>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-slate-400">
                  Was {tradePricePct.toFixed(1)}% when traded → Now{" "}
                  {currentProbPct?.toFixed(1)}%
                </span>
                {currentProbPct != null && Math.abs(delta) >= 0.5 && (
                  <span
                    className={
                      priceMovedInFavor ? "text-pulse-yes" : "text-red-400"
                    }
                  >
                    {priceMovedInFavor ? "↑" : "↓"}{" "}
                    {Math.abs(delta).toFixed(1)}%
                  </span>
                )}
              </div>
              <div className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-xs text-pulse-muted">Probability</p>
                  <p className="font-semibold text-pulse-accent">
                    {(matchedMarket.probability * 100).toFixed(1)}%
                  </p>
                </div>
                <div>
                  <p className="text-xs text-pulse-muted">Volume</p>
                  <p className="font-semibold text-white">
                    {formatVolumeUsd(matchedMarket.volume)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-pulse-muted">Spread</p>
                  <p className="font-semibold text-white">
                    {matchedMarket.spread == null
                      ? "—"
                      : `${matchedMarket.spread.toFixed(1)}¢`}
                  </p>
                </div>
              </div>
              <Link
                href={`/markets/${matchedMarket.id}`}
                className="inline-block text-sm text-pulse-accent hover:underline"
              >
                View full market →
              </Link>
            </div>
            {currentProbPct != null && (
              <p className="mt-4 text-sm text-slate-400">
                {getPriceMovementMessage(delta, trade.side)}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-400">
            Could not match this trade to a live market listing.
          </p>
        )}
      </section>

      {/* SECTION 7: BEGINNER LESSONS */}
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
            <p className="text-sm leading-relaxed text-slate-400">
              This market is priced at {priceCents}¢, meaning {probPct}%
              implied probability. If you traded this market 100 times at these
              odds:{"\n"}→ You&apos;d win roughly {Math.round(price * 100)} times
              {"\n"}→ You&apos;d lose roughly {100 - Math.round(price * 100)}{" "}
              times{"\n"}→ Break even requires winning more than {probPct}% of
              the time{"\n\n"}
              The question is: do you think the TRUE probability is higher or
              lower than {probPct}%?
            </p>
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
            <p className="mb-2 text-sm font-medium text-white">
              Lesson 3 — About the blockchain
            </p>
            <p className="whitespace-pre-line text-sm leading-relaxed text-slate-400">
              Every trade you see here is permanently recorded on the Polygon
              blockchain. This means:{"\n"}✅ No one can fake trades{"\n"}✅ No
              one can hide trades{"\n"}✅ You can verify everything
              independently{"\n\n"}
              This transparency is what makes prediction markets trustworthy —
              unlike traditional bookmakers, everything is public.
            </p>
          </div>
        </div>
      </section>

      {/* SECTION 8: QUICK VERDICT */}
      <section className="mb-8 rounded-xl border border-slate-600 bg-slate-700 p-5">
        <h2 className="mb-3 text-lg font-semibold text-white">⚡ Quick Take</h2>
        <p className="text-sm font-medium leading-relaxed text-white">
          {quickTake}
        </p>
      </section>

      {/* SECTION 9: NEARBY TRADES */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          🔗 Other Activity at the Same Time
        </h2>
        {filteredNearby.length === 0 ? (
          <p className="text-sm text-slate-400">
            All nearby trades were small retail activity under ${NEARBY_MIN_SIZE}.
          </p>
        ) : (
          <>
            <div className="space-y-3">
              {visibleNearby.map((t) => (
                <Link
                  key={t.id}
                  href={`/trades/${encodeURIComponent(t.transactionHash)}`}
                  className="block rounded-xl border border-slate-700 bg-slate-900/50 p-4 transition-colors hover:bg-slate-800"
                >
                  <p className="font-medium text-white">{t.title}</p>
                  <p className="text-sm text-slate-400">
                    {t.side} · ${Math.round(t.size).toLocaleString()} ·{" "}
                    {(t.price * 100).toFixed(1)}¢
                  </p>
                </Link>
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

      {/* SECTION 10: DISCLAIMER */}
      <p className="text-xs leading-relaxed text-slate-500">
        Trade data is for educational purposes only. Past trades do not predict
        future market movements. Never copy trades blindly.
      </p>
    </main>
  );
}
