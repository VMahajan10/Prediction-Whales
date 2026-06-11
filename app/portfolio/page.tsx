"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getExplorerMode, getPositionNarrative } from "@/lib/explorer";
import { fetchMarketProbabilities } from "@/lib/marketPrices";
import { getCopyStats } from "@/lib/copyTracking";
import {
  closePosition,
  getPortfolio,
  getPortfolioStats,
  getPositionPnL,
  getPositionValue,
  resetPortfolio,
  type Portfolio,
  type Position,
} from "@/lib/portfolio";

const REFRESH_MS = 30_000;
const STARTING_CASH = 1000;

function formatProb(probability: number): string {
  const pct = probability * 100;
  return pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1);
}

function truncateQuestion(question: string, maxLen: number): string {
  if (question.length <= maxLen) return question;
  return `${question.slice(0, maxLen)}…`;
}

function formatPnl(pnl: number, cost: number): string {
  const pct = cost > 0 ? (pnl / cost) * 100 : 0;
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}$${pnl.toFixed(2)} (${sign}${pct.toFixed(1)}%)`;
}

export default function PortfolioPage() {
  const [portfolio, setPortfolio] = useState<Portfolio>({
    cash: 1000,
    positions: [],
  });
  const [probabilities, setProbabilities] = useState<Record<string, number>>(
    {}
  );
  const [explorerMode, setExplorerMode] = useState(false);

  useEffect(() => {
    setExplorerMode(getExplorerMode());
  }, []);

  const refresh = useCallback(async () => {
    setPortfolio(getPortfolio());
    const probs = await fetchMarketProbabilities();
    setProbabilities(probs);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const stats = getPortfolioStats(portfolio, probabilities);
  const copyStats = getCopyStats();
  const openPositions = portfolio.positions.filter((p) => !p.resolved);
  const closedPositions = portfolio.positions.filter((p) => p.resolved);

  function handleClose(position: Position) {
    const prob =
      probabilities[position.marketId] ??
      (position.side === "YES" ? position.entryPrice : 1 - position.entryPrice);
    closePosition(position.id, prob);
    refresh();
  }

  function handleReset() {
    if (
      window.confirm(
        "Reset portfolio to $1,000 and clear all positions? This cannot be undone."
      )
    ) {
      resetPortfolio();
      refresh();
    }
  }

  function getCurrentProb(position: Position): number {
    return (
      probabilities[position.marketId] ??
      (position.side === "YES" ? position.entryPrice : 1 - position.entryPrice)
    );
  }

  function getYesProb(position: Position): number {
    if (probabilities[position.marketId] != null) {
      return probabilities[position.marketId];
    }
    return position.side === "YES"
      ? position.entryPrice
      : 1 - position.entryPrice;
  }

  function getSideProb(position: Position, yesProb: number): number {
    return position.side === "YES" ? yesProb : 1 - yesProb;
  }

  const totalBetCost = portfolio.positions.reduce((sum, p) => sum + p.cost, 0);
  const openPositionsValue = openPositions.reduce((sum, p) => {
    const prob = getYesProb(p);
    return sum + getPositionValue(p, prob);
  }, 0);
  const bestOpenBet = openPositions.reduce<{
    position: Position;
    pnl: number;
  } | null>((best, p) => {
    const prob = getYesProb(p);
    const pnl = getPositionPnL(p, prob);
    if (!best || pnl > best.pnl) return { position: p, pnl };
    return best;
  }, null);

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link
            href="/"
            className="mb-4 inline-block text-sm text-pulse-muted hover:text-white"
          >
            ← Back to Dashboard
          </Link>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">
            💼 My Portfolio
          </h1>
        </div>
        <button
          type="button"
          onClick={handleReset}
          className="rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10"
        >
          Reset Portfolio
        </button>
      </div>

      {explorerMode ? (
        <div className="mb-8 rounded-xl border border-blue-500/30 bg-slate-800 p-6">
          <p className="text-sm leading-relaxed text-slate-300">
            You started with ${STARTING_CASH.toLocaleString()}.
          </p>
          <p className="text-sm leading-relaxed text-slate-300">
            You&apos;ve placed {portfolio.positions.length} bet
            {portfolio.positions.length !== 1 ? "s" : ""} totaling $
            {totalBetCost.toFixed(2)}.
          </p>
          <p className="text-sm leading-relaxed text-slate-300">
            Right now your bets are worth ${openPositionsValue.toFixed(2)}.
          </p>
          <p className="text-sm leading-relaxed text-slate-300">
            You&apos;re {stats.totalPnL >= 0 ? "UP" : "DOWN"} $
            {Math.abs(stats.totalPnL).toFixed(2)} overall.{" "}
            {stats.totalPnL >= 0 ? "🟢" : "🔴"}
          </p>
          {bestOpenBet && bestOpenBet.pnl > 0 && (
            <p className="mt-2 text-sm text-slate-300">
              Your best bet so far:{" "}
              {truncateQuestion(bestOpenBet.position.question, 50)} (+
              {bestOpenBet.pnl.toFixed(2)})
            </p>
          )}
          <p className="mt-2 text-sm text-slate-400">
            Keep watching your positions — markets move fast!
          </p>
        </div>
      ) : (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-pulse-border bg-pulse-card p-4">
            <p className="text-xs text-pulse-muted">Total Value</p>
            <p className="text-xl font-semibold text-white">
              ${stats.totalValue.toFixed(2)}
            </p>
          </div>
          <div className="rounded-xl border border-pulse-border bg-pulse-card p-4">
            <p className="text-xs text-pulse-muted">Cash Available</p>
            <p className="text-xl font-semibold text-white">
              ${stats.cash.toFixed(2)}
            </p>
          </div>
          <div className="rounded-xl border border-pulse-border bg-pulse-card p-4">
            <p className="text-xs text-pulse-muted">Open Positions</p>
            <p className="text-xl font-semibold text-white">{stats.openCount}</p>
          </div>
          <div className="rounded-xl border border-pulse-border bg-pulse-card p-4">
            <p className="text-xs text-pulse-muted">Total P&L</p>
            <p
              className={`text-xl font-semibold ${
                stats.totalPnL >= 0 ? "text-pulse-yes" : "text-red-400"
              }`}
            >
              {stats.totalPnL >= 0 ? "+" : ""}${stats.totalPnL.toFixed(2)}
            </p>
          </div>
        </div>
      )}

      {portfolio.positions.length === 0 ? (
        <div className="rounded-xl border border-pulse-border bg-pulse-card/40 py-16 text-center">
          <p className="text-pulse-muted">
            No positions yet. Go find a market to trade!
          </p>
          <Link
            href="/"
            className="mt-4 inline-block text-pulse-accent hover:underline"
          >
            ← Back to Dashboard
          </Link>
        </div>
      ) : (
        <>
          <section className="mb-8">
            <h2 className="mb-4 text-lg font-semibold text-white">
              Open Positions
            </h2>
            {openPositions.length === 0 ? (
              <p className="text-sm text-pulse-muted">No open positions</p>
            ) : explorerMode ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {openPositions.map((position) => {
                  const yesProb = getYesProb(position);
                  const value = getPositionValue(position, yesProb);
                  const pnl = getPositionPnL(position, yesProb);
                  const entryYesProb =
                    position.side === "YES"
                      ? position.entryPrice
                      : 1 - position.entryPrice;
                  const narrative = getPositionNarrative(
                    position.side,
                    position.entryPrice,
                    getSideProb(position, yesProb),
                    pnl
                  );

                  return (
                    <div
                      key={position.id}
                      className="rounded-xl border border-slate-700 bg-slate-800 p-5"
                    >
                      <h3 className="mb-1 font-medium text-white">
                        {position.question}
                      </h3>
                      <p className="mb-4 text-xs text-slate-400">
                        {position.source === "kalshi"
                          ? "Kalshi"
                          : "Polymarket"}
                      </p>
                      <p className="mb-3 text-sm text-slate-300">
                        You bet: ${position.cost.toFixed(2)} that it{" "}
                        {position.side === "YES"
                          ? "WILL happen ✅"
                          : "WON'T happen ❌"}
                      </p>
                      <div className="mb-3 space-y-1 text-sm text-slate-400">
                        <p>
                          When you bet: {formatProb(entryYesProb)}% chance
                        </p>
                        <p>Right now: {formatProb(yesProb)}% chance</p>
                      </div>
                      <p className="mb-1 text-sm text-white">
                        Your bet is worth: ${value.toFixed(2)}
                      </p>
                      <p
                        className={`mb-4 text-sm font-medium ${
                          pnl >= 0 ? "text-pulse-yes" : "text-red-400"
                        }`}
                      >
                        You&apos;re {pnl >= 0 ? "UP" : "DOWN"} $
                        {Math.abs(pnl).toFixed(2)} so far{" "}
                        {pnl >= 0 ? "🟢" : "🔴"}
                      </p>
                      <div className="mb-4 rounded-lg bg-slate-900/60 p-3">
                        <p className="mb-1 text-xs font-medium text-slate-300">
                          What this means:
                        </p>
                        <p className="text-sm italic text-slate-400">
                          &ldquo;{narrative}&rdquo;
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleClose(position)}
                        className="w-full rounded-lg bg-pulse-accent py-2 text-sm font-medium text-white hover:bg-blue-600"
                      >
                        Close Bet
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-pulse-border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-pulse-card/60">
                    <tr className="text-pulse-muted">
                      <th className="px-4 py-3 font-medium">Market</th>
                      <th className="px-4 py-3 font-medium">Side</th>
                      <th className="px-4 py-3 font-medium">Entry</th>
                      <th className="px-4 py-3 font-medium">Current</th>
                      <th className="px-4 py-3 font-medium">Value</th>
                      <th className="px-4 py-3 font-medium">P&L</th>
                      <th className="px-4 py-3 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openPositions.map((position) => {
                      const prob = getCurrentProb(position);
                      const displayProb =
                        position.side === "YES" ? prob : 1 - prob;
                      const value = getPositionValue(position, prob);
                      const pnl = getPositionPnL(position, prob);

                      return (
                        <tr
                          key={position.id}
                          className="border-t border-pulse-border"
                        >
                          <td className="px-4 py-3">
                            <Link
                              href={`/markets/${position.marketId}`}
                              className="text-white hover:text-pulse-accent"
                            >
                              {truncateQuestion(position.question, 40)}
                            </Link>
                            <span
                              className={`ml-2 rounded-full px-1.5 py-0.5 text-xs ${
                                position.source === "kalshi"
                                  ? "bg-teal-900 text-teal-400"
                                  : "bg-slate-700 text-slate-400"
                              }`}
                            >
                              {position.source === "kalshi" ? "Kalshi" : "PM"}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                position.side === "YES"
                                  ? "bg-pulse-yes/20 text-pulse-yes"
                                  : "bg-red-500/20 text-red-400"
                              }`}
                            >
                              {position.side}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-white">
                            {formatProb(position.entryPrice)}%
                          </td>
                          <td className="px-4 py-3 text-white">
                            {formatProb(displayProb)}%
                          </td>
                          <td className="px-4 py-3 text-white">
                            ${value.toFixed(2)}
                          </td>
                          <td
                            className={`px-4 py-3 font-medium ${
                              pnl >= 0 ? "text-pulse-yes" : "text-red-400"
                            }`}
                          >
                            {formatPnl(pnl, position.cost)}
                          </td>
                          <td className="px-4 py-3">
                            <button
                              type="button"
                              onClick={() => handleClose(position)}
                              className="rounded bg-pulse-accent px-3 py-1 text-xs font-medium text-white hover:bg-blue-600"
                            >
                              Close
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {closedPositions.length > 0 && (
            <section>
              <h2 className="mb-4 text-lg font-semibold text-white">
                Closed Positions
              </h2>
              <div className="overflow-x-auto rounded-xl border border-pulse-border">
                <table className="w-full text-left text-sm text-slate-400">
                  <thead className="bg-pulse-card/40">
                    <tr>
                      <th className="px-4 py-3 font-medium">Market</th>
                      <th className="px-4 py-3 font-medium">Side</th>
                      <th className="px-4 py-3 font-medium">Entry</th>
                      <th className="px-4 py-3 font-medium">Exit</th>
                      <th className="px-4 py-3 font-medium">Value</th>
                      <th className="px-4 py-3 font-medium">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedPositions.map((position) => {
                      const exitProb = position.exitPrice ?? 0;
                      const exitValue = exitProb * position.shares;
                      const pnl = position.pnl ?? 0;

                      return (
                        <tr
                          key={position.id}
                          className="border-t border-pulse-border/50"
                        >
                          <td className="px-4 py-3">
                            {truncateQuestion(position.question, 40)}
                          </td>
                          <td className="px-4 py-3">{position.side}</td>
                          <td className="px-4 py-3">
                            {formatProb(position.entryPrice)}%
                          </td>
                          <td className="px-4 py-3">
                            {formatProb(exitProb)}%
                          </td>
                          <td className="px-4 py-3">
                            ${exitValue.toFixed(2)}
                          </td>
                          <td
                            className={`px-4 py-3 ${
                              pnl >= 0 ? "text-pulse-yes" : "text-red-400"
                            }`}
                          >
                            {formatPnl(pnl, position.cost)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      <section className="mt-10 rounded-xl border border-pulse-border bg-pulse-card/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          📊 Copy Bet Activity
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
            <p className="text-xs text-pulse-muted">Total Copy Taps</p>
            <p className="mt-1 text-2xl font-bold text-white">
              {copyStats.total}
            </p>
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
            <p className="text-xs text-pulse-muted">Last 7 Days</p>
            <p className="mt-1 text-2xl font-bold text-white">
              {copyStats.last7days}
            </p>
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
            <p className="text-xs text-pulse-muted">Avg Whale Size Followed</p>
            <p className="mt-1 text-2xl font-bold text-white">
              ${copyStats.avgWhaleSize.toLocaleString()}
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
