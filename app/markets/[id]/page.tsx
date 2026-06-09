"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import GlossaryTooltip from "@/components/GlossaryTooltip";
import PriceHistoryChart from "@/components/PriceHistoryChart";
import Toast from "@/components/Toast";
import {
  getBeginnerAdvice,
  getExplorerMode,
  GLOSSARY_TERMS,
} from "@/lib/explorer";
import { generateAnalysis } from "@/lib/marketAnalysis";
import type { Market, TradeSummary } from "@/lib/polymarket";
import { formatVolumeUsd } from "@/lib/polymarket";
import {
  buyPosition,
  closePosition,
  getOpenPositionForMarket,
  getPortfolio,
  getPositionPnL,
  getPositionValue,
  type Position,
} from "@/lib/portfolio";

function formatProbDisplay(probability: number): string {
  const pct = probability * 100;
  return pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1);
}

function formatContractPct(bestBuyYesCost: number): string {
  const pct = bestBuyYesCost * 100;
  return pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1);
}

function fuzzyMatchTitle(tradeTitle: string, marketQuestion: string): boolean {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const t = normalize(tradeTitle);
  const q = normalize(marketQuestion);
  if (t.includes(q.slice(0, Math.min(30, q.length)))) return true;
  if (q.includes(t.slice(0, Math.min(30, t.length)))) return true;
  const qWords = q.split(/\s+/).filter((w) => w.length > 4);
  const matches = qWords.filter((w) => t.includes(w)).length;
  return matches >= Math.min(3, qWords.length);
}

function formatTradeTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const h = date.getHours().toString().padStart(2, "0");
  const m = date.getMinutes().toString().padStart(2, "0");
  const s = date.getSeconds().toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function OutcomeDistributionLarge({ market }: { market: Market }) {
  const contracts = market.rawContracts ?? [];

  return (
    <div className="space-y-4">
      {contracts.map((contract) => (
        <div key={contract.id}>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
            <span className="text-slate-200">{contract.name}</span>
            <span className="font-semibold text-white">
              {formatContractPct(contract.bestBuyYesCost)}%
            </span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-slate-700">
            <div
              className="h-full rounded-full bg-purple-500"
              style={{
                width: `${Math.min(100, Math.max(0, contract.bestBuyYesCost * 100))}%`,
              }}
            />
          </div>
        </div>
      ))}
      {contracts.length === 0 && (
        <p className="text-sm text-slate-500">No open contracts</p>
      )}
    </div>
  );
}

export default function MarketDetailPage() {
  const params = useParams();
  const id = typeof params.id === "string" ? params.id : "";

  const [market, setMarket] = useState<Market | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [relatedTrades, setRelatedTrades] = useState<TradeSummary[]>([]);
  const [cash, setCash] = useState(1000);
  const [openPosition, setOpenPosition] = useState<Position | null>(null);
  const [dollarAmount, setDollarAmount] = useState(50);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
    visible: boolean;
  }>({ message: "", type: "success", visible: false });
  const [explorerMode, setExplorerMode] = useState(false);

  useEffect(() => {
    setExplorerMode(getExplorerMode());
  }, []);

  const refreshPortfolio = useCallback(() => {
    const portfolio = getPortfolio();
    setCash(portfolio.cash);
    if (market) {
      setOpenPosition(getOpenPositionForMarket(market.id));
    }
  }, [market]);

  const loadMarket = useCallback(async () => {
    try {
      const [pmRes, kalshiRes] = await Promise.all([
        fetch("/api/markets"),
        fetch("/api/kalshi"),
      ]);

      const pmData: { markets?: Market[] } = await pmRes.json();
      const kalshiData: { markets?: Market[] } = await kalshiRes.json();

      const found =
        [...(pmData.markets ?? []), ...(kalshiData.markets ?? [])].find(
          (m) => m.id === id
        ) ?? null;

      if (!found) {
        setNotFound(true);
        setMarket(null);
      } else {
        setMarket(found);
        setNotFound(false);
      }
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadRelatedTrades = useCallback(async (question: string) => {
    try {
      const res = await fetch("/api/trades");
      const data: { trades?: TradeSummary[] } = await res.json();
      const matched = (data.trades ?? [])
        .filter((t) => fuzzyMatchTitle(t.title, question))
        .slice(0, 5);
      setRelatedTrades(matched);
    } catch {
      setRelatedTrades([]);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    loadMarket();
  }, [loadMarket]);

  useEffect(() => {
    const interval = setInterval(loadMarket, 10_000);
    return () => clearInterval(interval);
  }, [loadMarket]);

  useEffect(() => {
    if (market?.source === "polymarket") {
      loadRelatedTrades(market.question);
    }
    refreshPortfolio();
  }, [market, loadRelatedTrades, refreshPortfolio]);

  useEffect(() => {
    if (!toast.visible) return;
    const timer = setTimeout(
      () => setToast((t) => ({ ...t, visible: false })),
      2100
    );
    return () => clearTimeout(timer);
  }, [toast.visible]);

  function handleBuy(side: "YES" | "NO") {
    if (!market) return;
    const amount = Math.min(dollarAmount, cash);
    const result = buyPosition(market, side, amount, market.probability);
    if (result.success) {
      setToast({
        message: "✓ Position opened!",
        type: "success",
        visible: true,
      });
      refreshPortfolio();
    } else {
      setToast({
        message: result.error ?? "Trade failed",
        type: "error",
        visible: true,
      });
    }
  }

  function handleClosePosition() {
    if (!market || !openPosition) return;
    closePosition(openPosition.id, market.probability);
    setToast({
      message: "✓ Position closed!",
      type: "success",
      visible: true,
    });
    refreshPortfolio();
  }

  const analysis = useMemo(
    () => (market ? generateAnalysis(market) : null),
    [market]
  );

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <p className="text-pulse-muted animate-pulse">Loading market…</p>
      </main>
    );
  }

  if (notFound || !market) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <Link href="/" className="text-sm text-pulse-accent hover:underline">
          ← Back to Dashboard
        </Link>
        <p className="mt-8 text-red-400">Market not found.</p>
      </main>
    );
  }

  const isPolymarket = market.source === "polymarket";
  const isKalshi = market.source === "kalshi";
  const prob = market.probability;
  const probDisplay = formatProbDisplay(prob);
  const noProbDisplay = formatProbDisplay(1 - prob);
  const amount = Math.min(Math.max(1, dollarAmount), cash);
  const potentialWin =
    prob > 0 ? amount / prob - amount : 0;

  const positionValue = openPosition
    ? getPositionValue(openPosition, prob)
    : 0;
  const positionPnL = openPosition ? getPositionPnL(openPosition, prob) : 0;
  const positionPnLPct =
    openPosition && openPosition.cost > 0
      ? (positionPnL / openPosition.cost) * 100
      : 0;
  const currentDisplayProb = openPosition
    ? openPosition.side === "YES"
      ? prob
      : 1 - prob
    : 0;

  const yesPayout = prob > 0 ? amount / prob : 0;
  const yesProfit = yesPayout - amount;
  const ev = prob * yesPayout - amount;
  const beginnerAdvice = getBeginnerAdvice(
    prob,
    market.spread,
    market.volume
  );

  if (explorerMode) {
    return (
      <main className="mx-auto min-h-screen max-w-4xl px-4 py-8 sm:px-6">
        <Link
          href="/"
          className="mb-8 inline-block text-sm text-pulse-muted transition-colors hover:text-white"
        >
          ← Back to Dashboard
        </Link>

        <header className="mb-8 border-b border-pulse-border pb-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                isKalshi
                  ? "bg-teal-900 text-teal-400"
                  : "bg-slate-700 text-slate-400"
              }`}
            >
              {isKalshi ? "Kalshi" : "Polymarket"}
            </span>
          </div>
          <h1 className="text-2xl font-bold leading-snug text-white sm:text-3xl">
            {market.question}
          </h1>
        </header>

        <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
          <h2 className="mb-4 text-lg font-semibold text-white">
            📖 What is this market?
          </h2>
          <p className="text-sm leading-relaxed text-slate-300">
            This market asks: <strong className="text-white">{market.question}</strong>
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-300">
            Right now, the crowd thinks there is a{" "}
            <GlossaryTooltip
              term="Probability"
              definition="The crowd's best guess of how likely this is to happen, shown as a percentage"
            >
              <span className="font-semibold text-pulse-accent">
                {probDisplay}%
              </span>
            </GlossaryTooltip>{" "}
            chance this happens. That means out of 100 people betting on this,{" "}
            {Math.round(prob * 100)} think YES and{" "}
            {100 - Math.round(prob * 100)} think NO.
          </p>
        </section>

        <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
          <h2 className="mb-4 text-lg font-semibold text-white">
            🎯 Is this a good bet?
          </h2>
          <div className="space-y-3">
            {beginnerAdvice.map((item, i) => (
              <div
                key={i}
                className="flex gap-3 rounded-lg border border-slate-700 bg-slate-900/50 p-4"
              >
                <span className="text-xl">{item.icon}</span>
                <p className="text-sm text-slate-300">{item.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
          <h2 className="mb-4 text-lg font-semibold text-white">
            📚 Trading Lesson: Expected Value
          </h2>
          <p className="mb-4 text-sm leading-relaxed text-slate-300">
            Expected Value (EV) is how traders decide if a bet is worth making.
          </p>
          <p className="mb-2 font-mono text-sm text-slate-400">
            EV = (Probability of winning × Payout) - Cost
          </p>
          <p className="mb-2 text-sm text-slate-300">
            For this market at {probDisplay}%:
          </p>
          <p className="mb-1 text-sm text-slate-400">
            If you bet ${amount} on YES:
          </p>
          <p className="mb-1 font-mono text-sm text-slate-300">
            EV = ({probDisplay}% × ${yesPayout.toFixed(2)}) - $
            {amount.toFixed(2)}
          </p>
          <p className="mb-4 font-mono text-sm text-white">
            EV = ${ev.toFixed(2)}
          </p>
          <p className="mb-4 text-sm text-slate-300">
            {Math.abs(ev) < 0.01
              ? "This is a FAIR bet — neither good nor bad mathematically."
              : ev > 0
                ? "Positive EV — mathematically favorable!"
                : "Negative EV — mathematically unfavorable."}
          </p>
          <p className="text-sm text-slate-400">
            💡 In a perfect market, EV is always $0 because prices adjust until
            no one has an edge. Real traders look for markets where they think
            the crowd is WRONG.
          </p>
        </section>

        <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
          <h2 className="mb-1 text-lg font-semibold text-white">
            💵 Practice Bet
          </h2>
          <p className="mb-4 text-sm text-pulse-muted">
            Practice trading with $1,000 virtual cash · No real money
          </p>
          <p className="mb-4 text-sm font-medium text-white">
            Balance: ${cash.toFixed(2)}
          </p>

          {openPosition ? (
            <div className="rounded-xl border border-pulse-border bg-pulse-card p-4">
              <h3 className="mb-3 text-sm font-semibold text-white">
                Your Open Bet
              </h3>
              <p className="mb-2 text-sm text-slate-300">
                You bet ${openPosition.cost.toFixed(2)} that it{" "}
                {openPosition.side === "YES"
                  ? "WILL happen ✅"
                  : "WON'T happen ❌"}
              </p>
              <p className="mb-2 text-sm text-slate-400">
                When you bet: {formatProbDisplay(openPosition.entryPrice)}%
                chance · Now: {formatProbDisplay(currentDisplayProb)}%
              </p>
              <p className="mb-2 text-sm text-white">
                Your bet is worth: ${positionValue.toFixed(2)}
              </p>
              <p
                className={`mb-4 text-sm font-medium ${
                  positionPnL >= 0 ? "text-pulse-yes" : "text-red-400"
                }`}
              >
                You&apos;re {positionPnL >= 0 ? "UP" : "DOWN"} $
                {Math.abs(positionPnL).toFixed(2)} so far{" "}
                {positionPnL >= 0 ? "🟢" : "🔴"}
              </p>
              <button
                type="button"
                onClick={handleClosePosition}
                className="rounded-lg bg-pulse-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
              >
                Close Bet
              </button>
            </div>
          ) : (
            <>
              <div className="mb-4">
                <label
                  htmlFor="trade-amount"
                  className="mb-1 block text-xs text-pulse-muted"
                >
                  How much to bet?
                </label>
                <input
                  id="trade-amount"
                  type="number"
                  min={1}
                  max={cash}
                  value={dollarAmount}
                  onChange={(e) =>
                    setDollarAmount(Math.max(1, Number(e.target.value) || 1))
                  }
                  className="w-full max-w-xs rounded-lg border border-pulse-border bg-pulse-card px-3 py-2 text-white focus:border-pulse-accent focus:outline-none"
                />
              </div>
              <div className="mb-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => handleBuy("YES")}
                  className="rounded-lg bg-pulse-yes/20 px-4 py-2 text-sm font-semibold text-pulse-yes transition-colors hover:bg-pulse-yes/30"
                >
                  Bet it WILL happen ✅ · {probDisplay}%
                </button>
                <button
                  type="button"
                  onClick={() => handleBuy("NO")}
                  className="rounded-lg bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-400 transition-colors hover:bg-red-500/30"
                >
                  Bet it WON&apos;T happen ❌ · {noProbDisplay}%
                </button>
              </div>
              <p className="mb-3 text-sm font-medium text-white">
                If you bet ${amount}:
              </p>
              <div className="mb-3 rounded-lg border border-pulse-yes/30 bg-pulse-yes/10 p-4">
                <p className="text-sm font-medium text-pulse-yes">
                  ✅ If it happens:
                </p>
                <p className="text-sm text-white">
                  You get ${yesPayout.toFixed(2)}
                </p>
                <p className="text-sm text-pulse-yes">
                  Profit: +${yesProfit.toFixed(2)}
                </p>
              </div>
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
                <p className="text-sm font-medium text-red-400">
                  ❌ If it doesn&apos;t:
                </p>
                <p className="text-sm text-white">
                  You lose ${amount.toFixed(2)}
                </p>
              </div>
            </>
          )}
        </section>

        <section className="mb-8 rounded-xl border border-pulse-border bg-slate-800 p-6">
          <h2 className="mb-4 text-lg font-semibold text-white">
            📖 Glossary
          </h2>
          <dl className="space-y-0">
            {GLOSSARY_TERMS.map((item) => (
              <div
                key={item.term}
                className="border-b border-slate-700 py-3 last:border-0"
              >
                <dt className="font-semibold text-white">{item.term}</dt>
                <dd className="mt-1 text-sm text-slate-400">
                  {item.definition}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <Toast
          message={toast.message}
          type={toast.type}
          visible={toast.visible}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-8 sm:px-6">
      <Link
        href="/"
        className="mb-8 inline-block text-sm text-pulse-muted transition-colors hover:text-white"
      >
        ← Back to Dashboard
      </Link>

      {/* HEADER */}
      <header className="mb-8 border-b border-pulse-border pb-8">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              isKalshi
                ? "bg-teal-900 text-teal-400"
                : "bg-slate-700 text-slate-400"
            }`}
          >
            {isKalshi ? "Kalshi" : "Polymarket"}
          </span>
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              market.active
                ? "bg-pulse-yes/20 text-pulse-yes"
                : "bg-gray-700/50 text-pulse-muted"
            }`}
          >
            {market.active ? "Active" : "Inactive"}
          </span>
        </div>

        <h1 className="mb-6 text-2xl font-bold leading-snug text-white sm:text-3xl">
          {market.question}
        </h1>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <p className="text-xs text-pulse-muted">Probability</p>
            <p className="text-lg font-semibold text-pulse-accent">
              {formatProbDisplay(market.probability)}%
            </p>
          </div>
          <div>
            <p className="text-xs text-pulse-muted">Volume</p>
            <p className="text-lg font-semibold text-white">
              {isPolymarket || isKalshi
                ? formatVolumeUsd(market.volume)
                : "N/A"}
            </p>
          </div>
          <div>
            <p className="text-xs text-pulse-muted">Spread</p>
            <p className="text-lg font-semibold text-white">
              {market.spread == null ? "—" : `${market.spread.toFixed(1)}¢`}
            </p>
          </div>
          <div>
            <p className="text-xs text-pulse-muted">Source</p>
            <p className="text-lg font-semibold capitalize text-white">
              {market.source}
            </p>
          </div>
        </div>
      </header>

      {/* CHART */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          {isPolymarket ? "Price History (1h)" : "Outcome Distribution"}
        </h2>
        {isPolymarket && market.clobTokenIds[0] ? (
          <PriceHistoryChart tokenId={market.clobTokenIds[0]} />
        ) : (
          <OutcomeDistributionLarge market={market} />
        )}
      </section>

      {/* MARKET ANALYSIS */}
      {analysis && (
        <section className="mb-8 rounded-xl bg-slate-800 p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-white">
              📊 Market Analysis
            </h2>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                analysis.confidence === "High"
                  ? "bg-pulse-yes/20 text-pulse-yes"
                  : analysis.confidence === "Low"
                    ? "bg-red-500/20 text-red-400"
                    : "bg-yellow-500/20 text-yellow-400"
              }`}
            >
              {analysis.confidence} Confidence
            </span>
          </div>

          <p className="mb-5 text-sm leading-relaxed text-slate-300">
            {analysis.summary}
          </p>

          <div className="space-y-4 text-sm">
            <div>
              <p className="mb-1 font-medium text-slate-200">
                🎯 Probability Signal
              </p>
              <p className="text-slate-400">{analysis.probabilityInsight}</p>
            </div>
            <div>
              <p className="mb-1 font-medium text-slate-200">💧 Liquidity</p>
              <p className="text-slate-400">{analysis.spreadInsight}</p>
            </div>
            {analysis.volumeInsight && (
              <div>
                <p className="mb-1 font-medium text-slate-200">📈 Volume</p>
                <p className="text-slate-400">{analysis.volumeInsight}</p>
              </div>
            )}
            <div>
              <p className="mb-1 font-medium text-slate-200">⚖️ Verdict</p>
              <p className="text-slate-200">{analysis.verdict}</p>
            </div>
          </div>
        </section>
      )}

      {/* PAPER TRADE */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-1 text-lg font-semibold text-white">
          💵 Paper Trade (Simulated)
        </h2>
        <p className="mb-4 text-sm text-pulse-muted">
          Practice trading with $1,000 virtual cash · No real money
        </p>
        <p className="mb-4 text-sm font-medium text-white">
          Balance: ${cash.toFixed(2)}
        </p>

        {openPosition ? (
          <div className="rounded-xl border border-pulse-border bg-pulse-card p-4">
            <h3 className="mb-3 text-sm font-semibold text-white">
              Your Position
            </h3>
            <div className="mb-3 flex flex-wrap gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                  openPosition.side === "YES"
                    ? "bg-pulse-yes/20 text-pulse-yes"
                    : "bg-red-500/20 text-red-400"
                }`}
              >
                {openPosition.side}
              </span>
            </div>
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p className="text-pulse-muted">
                Entry price:{" "}
                <span className="text-white">
                  {formatProbDisplay(openPosition.entryPrice)}%
                </span>
              </p>
              <p className="text-pulse-muted">
                Current price:{" "}
                <span className="text-white">
                  {formatProbDisplay(currentDisplayProb)}%
                </span>
              </p>
              <p className="text-pulse-muted">
                Current value:{" "}
                <span className="text-white">
                  ${positionValue.toFixed(2)}
                </span>
              </p>
              <p className="text-pulse-muted">
                P&L:{" "}
                <span
                  className={
                    positionPnL >= 0 ? "text-pulse-yes" : "text-red-400"
                  }
                >
                  {positionPnL >= 0 ? "+" : ""}${positionPnL.toFixed(2)} (
                  {positionPnL >= 0 ? "+" : ""}
                  {positionPnLPct.toFixed(1)}%)
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={handleClosePosition}
              className="mt-4 rounded-lg bg-pulse-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
            >
              Close Position
            </button>
          </div>
        ) : (
          <>
            <div className="mb-4">
              <label
                htmlFor="trade-amount"
                className="mb-1 block text-xs text-pulse-muted"
              >
                Dollar amount
              </label>
              <input
                id="trade-amount"
                type="number"
                min={1}
                max={cash}
                value={dollarAmount}
                onChange={(e) =>
                  setDollarAmount(Math.max(1, Number(e.target.value) || 1))
                }
                className="w-full max-w-xs rounded-lg border border-pulse-border bg-pulse-card px-3 py-2 text-white focus:border-pulse-accent focus:outline-none"
              />
            </div>
            <div className="mb-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => handleBuy("YES")}
                className="rounded-lg bg-pulse-yes/20 px-4 py-2 text-sm font-semibold text-pulse-yes transition-colors hover:bg-pulse-yes/30"
              >
                Buy YES · {probDisplay}%
              </button>
              <button
                type="button"
                onClick={() => handleBuy("NO")}
                className="rounded-lg bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-400 transition-colors hover:bg-red-500/30"
              >
                Buy NO · {noProbDisplay}%
              </button>
            </div>
            <div className="space-y-1 text-sm text-pulse-muted">
              <p>
                If YES resolves: +${potentialWin.toFixed(2)}
              </p>
              <p>If NO resolves: -${amount.toFixed(2)}</p>
              <p>Implied odds: {probDisplay}% chance of YES</p>
            </div>
          </>
        )}
      </section>

      <Toast
        message={toast.message}
        type={toast.type}
        visible={toast.visible}
      />

      {/* METADATA */}
      <section className="mb-8 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          Market Metadata
        </h2>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-pulse-muted">Market ID</dt>
            <dd className="font-mono text-white">{market.id}</dd>
          </div>
          <div>
            <dt className="text-pulse-muted">Condition ID</dt>
            <dd className="font-mono text-white">{market.conditionId}</dd>
          </div>
          <div>
            <dt className="text-pulse-muted">Source Platform</dt>
            <dd>
              {isPolymarket ? (
                <a
                  href={`https://polymarket.com/event/${market.conditionId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-pulse-accent hover:underline"
                >
                  View on Polymarket →
                </a>
              ) : isKalshi ? (
                <a
                  href={
                    market.url ??
                    `https://kalshi.com/markets/${market.id}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-pulse-accent hover:underline"
                >
                  View on Kalshi →
                </a>
              ) : (
                <span className="text-white">{market.source}</span>
              )}
            </dd>
          </div>
          {isPolymarket && (
            <div>
              <dt className="text-pulse-muted">Blockchain</dt>
              <dd>
                <a
                  href={`https://polygonscan.com/address/${market.conditionId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-pulse-accent hover:underline"
                >
                  View on Polygonscan →
                </a>
              </dd>
            </div>
          )}
        </dl>
      </section>

      {/* RELATED TRADES */}
      {isPolymarket && (
        <section className="rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
          <h2 className="mb-4 text-lg font-semibold text-white">
            Related Trades
          </h2>
          {relatedTrades.length === 0 ? (
            <p className="text-sm text-pulse-muted">
              No recent trades for this market
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-pulse-border text-pulse-muted">
                    <th className="pb-2 pr-4 font-medium">Side</th>
                    <th className="pb-2 pr-4 font-medium">Outcome</th>
                    <th className="pb-2 pr-4 font-medium">Price</th>
                    <th className="pb-2 pr-4 font-medium">Size</th>
                    <th className="pb-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {relatedTrades.map((trade) => (
                    <tr
                      key={trade.id}
                      className="border-b border-pulse-border/50"
                    >
                      <td
                        className={`py-2 pr-4 font-medium ${
                          trade.side === "BUY"
                            ? "text-pulse-yes"
                            : "text-red-400"
                        }`}
                      >
                        {trade.side}
                      </td>
                      <td className="py-2 pr-4 text-white">{trade.outcome}</td>
                      <td className="py-2 pr-4 text-white">
                        {(trade.price * 100).toFixed(1)}¢
                      </td>
                      <td className="py-2 pr-4 text-white">
                        ${trade.size.toFixed(0)}
                      </td>
                      <td className="py-2 text-pulse-muted">
                        {formatTradeTime(trade.timestamp)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
