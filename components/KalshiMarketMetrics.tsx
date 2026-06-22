"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import type { OutcomeBooks } from "@/lib/crossMarketEv";
import {
  crossMarketEvUnavailableReason,
  evColorClass,
  evPricingSignal,
  evPricingSignalClass,
  fairSourceLabel,
  formatEvPercent,
} from "@/lib/crossMarketEvDisplay";
import type {
  KalshiMarketDetail,
  KalshiMarketFlow,
  KalshiOrderBook,
  KalshiTradeDetail,
} from "@/lib/kalshiDetail";
import { formatKalshiContractCount } from "@/lib/kalshiDetail";
import {
  computeLiquidityMetrics,
  computeOrderBookFairValue,
  flowLeanLabel,
  spreadQualityLabel,
} from "@/lib/kalshiMarketMetrics";
import {
  resolveCrossMarketEvForTrade,
  type TradeEvInput,
} from "@/lib/resolveTradeCrossMarketEv";

interface KalshiMarketMetricsProps {
  trade: KalshiTradeDetail;
  market: KalshiMarketDetail | null;
  orderbook: KalshiOrderBook | null;
  marketFlow: KalshiMarketFlow | null;
  evIndex: Map<string, OutcomeBooks>;
  enriching?: boolean;
}

function MetricCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-5">
      <h3 className="mb-1 text-sm font-semibold text-white">{title}</h3>
      <p className="mb-4 text-xs leading-relaxed text-slate-500">
        {description}
      </p>
      {children}
    </div>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <p className="text-sm text-slate-500">
      Not enough data — {message}
    </p>
  );
}

export default function KalshiMarketMetrics({
  trade,
  market,
  orderbook,
  marketFlow,
  evIndex,
  enriching = false,
}: KalshiMarketMetricsProps) {
  const tradeEvInput: TradeEvInput = useMemo(
    () => ({
      source: "kalshi",
      price: trade.price,
      ticker: trade.ticker,
    }),
    [trade.price, trade.ticker]
  );

  const crossEv = useMemo(
    () => resolveCrossMarketEvForTrade(tradeEvInput, evIndex),
    [tradeEvInput, evIndex]
  );

  const bookFair = useMemo(
    () => computeOrderBookFairValue(trade, market),
    [trade, market]
  );

  const liquidity = useMemo(
    () => computeLiquidityMetrics(market, orderbook),
    [market, orderbook]
  );

  const crossEvOk =
    crossEv.reason === "ok" &&
    crossEv.ev != null &&
    crossEv.fairSource != null &&
    crossEv.fairProb != null;

  const crossSignal = crossEvOk ? evPricingSignal(crossEv.ev!) : null;
  const bookSignal = bookFair ? evPricingSignal(bookFair.evPercent) : null;
  const flowLean = marketFlow ? flowLeanLabel(marketFlow) : null;

  return (
    <section className="mb-8 rounded-xl border border-pulse-accent/30 bg-gradient-to-br from-slate-800 to-slate-900 p-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-white">📊 Market Metrics</h2>
        <p className="mt-1 text-sm text-slate-400">
          Live market-level numbers for this contract — anonymous aggregate flow,
          liquidity, and price-vs-fair checks. Not trader-specific stats.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* EV */}
        <MetricCard
          title="Expected Value (price vs fair)"
          description="Compares what was paid to a live fair reference — cross-market when matched, otherwise the current order-book mid. Not settlement EV."
        >
          {enriching && !market ? (
            <div className="space-y-3">
              <div className="h-4 w-3/4 animate-pulse rounded bg-slate-700" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-slate-700" />
            </div>
          ) : (
            <div className="space-y-4">
              {crossEvOk ? (
                <div className="rounded-lg border border-slate-600 bg-slate-800/80 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Cross-market (primary)
                  </p>
                  <p
                    className={`mt-1 text-2xl font-bold ${evColorClass(crossEv.ev!)}`}
                  >
                    {formatEvPercent(crossEv.ev!)}
                  </p>
                  <p
                    className={`mt-1 text-sm font-semibold ${evPricingSignalClass(crossSignal!)}`}
                  >
                    {crossSignal}
                  </p>
                  <p className="mt-2 text-xs text-slate-400">
                    Paid {(crossEv.pricePaid! * 100).toFixed(1)}¢ vs{" "}
                    {fairSourceLabel(crossEv.fairSource!)} fair{" "}
                    {(crossEv.fairProb! * 100).toFixed(1)}¢ on the same game.
                  </p>
                </div>
              ) : crossEv.reason && crossEv.reason !== "ok" ? (
                <Unavailable
                  message={crossMarketEvUnavailableReason(crossEv.reason)}
                />
              ) : evIndex.size === 0 ? (
                <Unavailable message="cross-market index still loading." />
              ) : (
                <Unavailable message="no clean cross-market match for this ticker." />
              )}

              {bookFair ? (
                <div className="rounded-lg border border-slate-600 bg-slate-800/80 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Order-book fair value
                  </p>
                  <p
                    className={`mt-1 text-xl font-bold ${evColorClass(bookFair.evPercent)}`}
                  >
                    {formatEvPercent(bookFair.evPercent)}
                  </p>
                  <p
                    className={`mt-1 text-sm font-semibold ${evPricingSignalClass(bookSignal!)}`}
                  >
                    {bookSignal}
                  </p>
                  <p className="mt-2 text-xs text-slate-400">
                    Trade hit {(bookFair.tradePrice * 100).toFixed(1)}¢; current{" "}
                    {bookFair.outcome} mid is{" "}
                    {(bookFair.currentMid * 100).toFixed(1)}¢.
                  </p>
                </div>
              ) : (
                <Unavailable message="live order-book mid unavailable yet." />
              )}
            </div>
          )}
        </MetricCard>

        {/* FLOW */}
        <MetricCard
          title="Anonymous market flow"
          description="Large trades on this ticker today (≥ $500), split by side. Aggregate only — not tied to any wallet or trader."
        >
          {enriching && !marketFlow ? (
            <div className="h-16 animate-pulse rounded bg-slate-700" />
          ) : marketFlow && marketFlow.largeTradeCount > 0 ? (
            <div>
              <p className="text-2xl font-bold text-white">
                {marketFlow.yesPct.toFixed(0)}% YES{" "}
                <span className="text-slate-500">/</span>{" "}
                {marketFlow.noPct.toFixed(0)}% NO
              </p>
              <p className="mt-2 text-sm text-slate-300">
                Large trades today:{" "}
                <strong className="text-green-400">
                  {marketFlow.yesPct.toFixed(0)}% YES
                </strong>{" "}
                /{" "}
                <strong className="text-red-400">
                  {marketFlow.noPct.toFixed(0)}% NO
                </strong>
                {flowLean && (
                  <>
                    {" "}
                    — <span className="text-white">{flowLean}</span>
                  </>
                )}
              </p>
              <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-700">
                <div
                  className="bg-green-500"
                  style={{ width: `${marketFlow.yesPct}%` }}
                />
                <div
                  className="bg-red-500"
                  style={{ width: `${marketFlow.noPct}%` }}
                />
              </div>
              <p className="mt-3 text-xs text-slate-500">
                {marketFlow.largeTradeCount} large trade
                {marketFlow.largeTradeCount === 1 ? "" : "s"} · $
                {marketFlow.totalLargeVolume.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}{" "}
                total notional ({marketFlow.windowLabel})
              </p>
            </div>
          ) : (
            <Unavailable
              message={
                marketFlow
                  ? `no large trades today (≥ $${marketFlow.minNotionalUsd.toLocaleString()}).`
                  : enriching
                    ? "flow data still loading."
                    : "could not load flow for this ticker."
              }
            />
          )}
        </MetricCard>

        {/* LIQUIDITY */}
        <MetricCard
          title="Liquidity & depth"
          description="How easy it is to trade this market right now — spread tightness, resting depth, and activity."
        >
          {enriching && !market ? (
            <div className="h-16 animate-pulse rounded bg-slate-700" />
          ) : market ? (
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-slate-500">Bid/ask spread (Yes)</p>
                <p className="text-lg font-semibold text-white">
                  {liquidity.spreadCents != null
                    ? `${liquidity.spreadCents.toFixed(1)}¢`
                    : "—"}
                </p>
                {liquidity.spreadQuality && (
                  <p className="mt-1 text-xs text-slate-400">
                    {spreadQualityLabel(liquidity.spreadQuality)}
                  </p>
                )}
              </div>
              {liquidity.depth && (
                <div>
                  <p className="text-xs text-slate-500">Resting book depth</p>
                  <p className="text-white">
                    Yes:{" "}
                    {formatKalshiContractCount(liquidity.depth.yesContracts)}{" "}
                    · No:{" "}
                    {formatKalshiContractCount(liquidity.depth.noContracts)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatKalshiContractCount(
                      liquidity.depth.totalContracts
                    )}{" "}
                    contracts total on the book
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-slate-500">Volume (24h)</p>
                  <p className="font-semibold text-white">
                    {liquidity.volume24h != null
                      ? `${formatKalshiContractCount(liquidity.volume24h)} contracts`
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">Open interest</p>
                  <p className="font-semibold text-white">
                    {liquidity.openInterest != null
                      ? `${formatKalshiContractCount(liquidity.openInterest)} contracts`
                      : "—"}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <Unavailable message="could not load live market quotes for this ticker." />
          )}
        </MetricCard>
      </div>
    </section>
  );
}
