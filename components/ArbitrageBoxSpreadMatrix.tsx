"use client";

import { useEffect, useState } from "react";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { pipelineMappingPairKey } from "@/lib/evPipeline/crossAssetLookup";
import {
  pipelineEvTooltip,
  pipelineEvTone,
  resolveDetailPanelDisplayEv,
} from "@/lib/evPipeline/tradeEvRecord";
import { inferMarketCategory } from "@/lib/marketCategory";

export interface ArbitrageLeg {
  venue: "polymarket" | "kalshi" | "exchange";
  side: "YES" | "NO";
  contractId: string;
  askPrice: number;
}

export interface ArbitrageOpportunity {
  mappingPairKey: string;
  polymarketTokenId: string;
  kalshiTicker: string | null;
  strategy: "pm_yes_kalshi_no" | "kalshi_yes_pm_no" | "pm_vs_exchange_arb";
  legs: ArbitrageLeg[];
  combinedCost: number;
  guaranteedPayout: number;
  netProfitPerUnit: number;
  netRoiPercent: number;
  pmYesAsk: number;
  pmNoAsk: number;
  kalshiYesAsk: number | null;
  kalshiNoAsk: number | null;
  exchangeYesBid?: number | null;
  exchangeYesAsk?: number | null;
  exchangeLabel?: string | null;
  secondaryVenue?: "kalshi" | "exchange";
}

interface BoxSpreadSnapshot {
  pmYesAsk: number | null;
  opposingNoAsk: number | null;
  opposingVenue: "polymarket" | "kalshi" | "exchange";
  opposingVenueLabel: string;
  combinedCost: number | null;
  impliedSumPercent?: number | null;
  netProfitDelta: number | null;
  netRoiPercent: number | null;
  isActionable: boolean;
  isExecutable?: boolean;
  degraded?: boolean;
  primaryQuoteSource?: string | null;
  opposingQuoteSource?: string | null;
  exchangeNoAsk?: number | null;
  kalshiNoAsk?: number | null;
  status?: string;
  statusMessage?: string;
}

interface ExchangeBaselineSnapshot {
  yesBid: number;
  yesAsk: number;
  exchangeNoAsk?: number | null;
  label: string;
  bookmakerCount: number;
  outcomeLabel?: string | null;
}

interface ArbitrageApiResponse {
  pairKey?: string;
  tokenId?: string;
  source?: string;
  alert?: ArbitrageOpportunity | null;
  arbitrage?: ArbitrageOpportunity | null;
  baseline?: ExchangeBaselineSnapshot | null;
  exchangeNoAsk?: number | null;
  spreadStatus?: string;
  spreadStatusMessage?: string;
  boxSpread?: BoxSpreadSnapshot | null;
  spread?: BoxSpreadSnapshot | null;
  error?: string;
}

export interface ArbitrageTradeLinks {
  eventSlug?: string;
  slug?: string;
}

export function resolveMappingPairKey(
  pipelineData: PipelineTradeEv | null | undefined
): string | null {
  if (!pipelineData) return null;
  if (pipelineData.mappingPairKey) return pipelineData.mappingPairKey;
  if (pipelineData.tokenId && pipelineData.kalshiTicker) {
    return pipelineMappingPairKey(
      pipelineData.tokenId,
      pipelineData.kalshiTicker
    );
  }
  return null;
}

export function isPairedPipelineTrade(
  pipelineData: PipelineTradeEv | null | undefined
): boolean {
  return resolveMappingPairKey(pipelineData) != null;
}

function formatCents(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

function formatCentsOrSkeleton(
  value: number | null | undefined,
  loading: boolean
): string {
  if (loading) return "…";
  if (value == null || !Number.isFinite(value)) return "50.0¢";
  return formatCents(value);
}

function formatDollars(value: number): string {
  return `$${value.toFixed(3)}`;
}

function formatArbitrageSum(
  combinedCost: number | null | undefined,
  loading: boolean
): string {
  if (loading) return "…";
  if (combinedCost == null || !Number.isFinite(combinedCost)) return "100.0%";
  return `${(combinedCost * 100).toFixed(1)}% · ${formatDollars(combinedCost)}`;
}

function formatProfitDeltaOrSkeleton(
  value: number | null | undefined,
  loading: boolean
): string {
  if (loading) return "…";
  if (value == null || !Number.isFinite(value)) return "$0.000";
  const sign = value >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(value).toFixed(3)}`;
}

function opposingVenueRowLabel(box: BoxSpreadSnapshot | null): string {
  if (!box) return "Opposing Venue NO Ask";
  const source = box.opposingQuoteSource
    ? ` · ${quoteSourceLabel(box.opposingQuoteSource)}`
    : "";
  if (box.opposingVenue === "polymarket") {
    return `Polymarket NO Ask · ${box.opposingVenueLabel}${source}`;
  }
  if (box.opposingVenue === "kalshi") {
    return `Kalshi NO Ask · ${box.opposingVenueLabel}${source}`;
  }
  return `Exchange NO Ask · ${box.opposingVenueLabel}${source}`;
}

function quoteSourceLabel(source: string): string {
  if (source === "p_true") return "pTrue proxy";
  if (source === "consensus") return "sportsbook proxy";
  if (source === "mid_proxy") return "mid proxy";
  if (source === "trade_price") return "trade price";
  if (source === "universal_prior") return "universal prior";
  if (source === "complement") return "complement proxy";
  return "live book";
}

function matrixFromArbDetails(
  arb: ArbitrageOpportunity
): BoxSpreadSnapshot | null {
  const opposingVenue: "kalshi" | "exchange" =
    arb.strategy === "pm_vs_exchange_arb" || arb.secondaryVenue === "exchange"
      ? "exchange"
      : "kalshi";

  const opposingNoAsk =
    opposingVenue === "exchange"
      ? (arb.legs.find((leg) => leg.venue === "exchange" && leg.side === "NO")
          ?.askPrice ?? null)
      : arb.kalshiNoAsk;

  const combinedCost =
    arb.pmYesAsk != null && opposingNoAsk != null
      ? Math.round((arb.pmYesAsk + opposingNoAsk) * 10000) / 10000
      : arb.combinedCost;
  const netProfitDelta =
    combinedCost != null
      ? Math.round((1 - combinedCost) * 10000) / 10000
      : arb.netProfitPerUnit;

  return {
    pmYesAsk: arb.pmYesAsk,
    opposingNoAsk,
    opposingVenue,
    opposingVenueLabel:
      opposingVenue === "exchange"
        ? (arb.exchangeLabel ?? "Exchange")
        : (arb.kalshiTicker ?? "Kalshi"),
    combinedCost,
    netProfitDelta,
    netRoiPercent: arb.netRoiPercent,
    isActionable: (netProfitDelta ?? 0) > 0 && arb.netProfitPerUnit > 0,
  };
}

function roundSpread4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function computeSpreadRoiPercent(combinedCost: number): number {
  return Math.round(((1 - combinedCost) / combinedCost) * 1000) / 10;
}

function resolvePmYesAsk(
  matrix: BoxSpreadSnapshot | null,
  arbDetails: ArbitrageOpportunity | null,
  tradePrice?: number | null
): number | null {
  if (matrix?.pmYesAsk != null && Number.isFinite(matrix.pmYesAsk)) {
    return matrix.pmYesAsk;
  }
  if (arbDetails?.pmYesAsk != null && Number.isFinite(arbDetails.pmYesAsk)) {
    return arbDetails.pmYesAsk;
  }
  if (tradePrice != null && Number.isFinite(tradePrice)) {
    return tradePrice;
  }
  return null;
}

function exchangeNoAskFromBaseline(
  baseline: ExchangeBaselineSnapshot
): number | null {
  if (
    baseline.exchangeNoAsk != null &&
    Number.isFinite(baseline.exchangeNoAsk)
  ) {
    return baseline.exchangeNoAsk;
  }
  if (baseline.yesAsk != null && Number.isFinite(baseline.yesAsk)) {
    return roundSpread4(1 - baseline.yesAsk);
  }
  return null;
}

function resolveExchangeNoAsk(
  matrix: BoxSpreadSnapshot | null,
  baseline: ExchangeBaselineSnapshot | null
): number | null {
  if (matrix?.exchangeNoAsk != null && Number.isFinite(matrix.exchangeNoAsk)) {
    return matrix.exchangeNoAsk;
  }
  if (
    matrix?.opposingVenue === "exchange" &&
    matrix.opposingNoAsk != null &&
    Number.isFinite(matrix.opposingNoAsk)
  ) {
    return matrix.opposingNoAsk;
  }
  if (baseline) {
    return exchangeNoAskFromBaseline(baseline);
  }
  return null;
}

/** Fill PM ask from trade price and recompute box totals when legs are known. */
function finalizeMatrixSnapshot(
  matrix: BoxSpreadSnapshot,
  arbDetails: ArbitrageOpportunity | null,
  baseline: ExchangeBaselineSnapshot | null,
  tradePrice?: number | null
): BoxSpreadSnapshot {
  const pmYesAsk = resolvePmYesAsk(matrix, arbDetails, tradePrice);
  const exchangeNoAsk = resolveExchangeNoAsk(matrix, baseline);
  const kalshiNoAsk =
    matrix.kalshiNoAsk ??
    (matrix.opposingVenue === "kalshi" ? matrix.opposingNoAsk : null) ??
    arbDetails?.kalshiNoAsk ??
    null;

  const preferExchangeLeg =
    matrix.opposingVenue !== "polymarket" &&
    (arbDetails?.strategy === "pm_vs_exchange_arb" ||
      arbDetails?.secondaryVenue === "exchange" ||
      (!arbDetails && exchangeNoAsk != null) ||
      (exchangeNoAsk != null && kalshiNoAsk == null));

  const opposingNoAsk = preferExchangeLeg && exchangeNoAsk != null
    ? exchangeNoAsk
    : matrix.opposingVenue === "kalshi"
      ? kalshiNoAsk
      : exchangeNoAsk ?? matrix.opposingNoAsk ?? kalshiNoAsk;

  const opposingVenue: "polymarket" | "kalshi" | "exchange" =
    preferExchangeLeg && exchangeNoAsk != null
      ? "exchange"
      : opposingNoAsk === kalshiNoAsk && kalshiNoAsk != null
        ? "kalshi"
        : exchangeNoAsk != null
          ? "exchange"
          : matrix.opposingVenue;

  const combinedCost =
    pmYesAsk != null && opposingNoAsk != null
      ? roundSpread4(pmYesAsk + opposingNoAsk)
      : matrix.combinedCost;
  const netProfitDelta =
    combinedCost != null
      ? roundSpread4(1 - combinedCost)
      : matrix.netProfitDelta;

  return {
    ...matrix,
    pmYesAsk,
    opposingNoAsk,
    exchangeNoAsk,
    kalshiNoAsk,
    opposingVenue,
    combinedCost,
    impliedSumPercent:
      combinedCost != null ? Math.round(combinedCost * 1000) / 10 : null,
    netProfitDelta,
    netRoiPercent:
      combinedCost != null
        ? computeSpreadRoiPercent(combinedCost)
        : matrix.netRoiPercent,
    isActionable:
      matrix.isExecutable !== false &&
      combinedCost != null &&
      combinedCost < 0.98 &&
      (netProfitDelta ?? 0) > 0,
    status: matrix.status,
    statusMessage: matrix.statusMessage,
  };
}

function matrixFromBaseline(
  baseline: ExchangeBaselineSnapshot,
  tradePrice?: number | null
): BoxSpreadSnapshot {
  const exchangeNoAsk = exchangeNoAskFromBaseline(baseline);
  if (exchangeNoAsk == null) {
    return {
      pmYesAsk:
        tradePrice != null && Number.isFinite(tradePrice) ? tradePrice : null,
      opposingNoAsk: null,
      exchangeNoAsk: null,
      opposingVenue: "exchange",
      opposingVenueLabel: baseline.label,
      combinedCost: null,
      netProfitDelta: null,
      netRoiPercent: null,
      isActionable: false,
    };
  }
  const pmYesAsk =
    tradePrice != null && Number.isFinite(tradePrice) ? tradePrice : null;
  const combinedCost =
    pmYesAsk != null ? roundSpread4(pmYesAsk + exchangeNoAsk) : null;
  const netProfitDelta =
    combinedCost != null ? roundSpread4(1 - combinedCost) : null;

  return finalizeMatrixSnapshot(
    {
      pmYesAsk,
      opposingNoAsk: exchangeNoAsk,
      exchangeNoAsk,
      opposingVenue: "exchange",
      opposingVenueLabel: baseline.label,
      combinedCost,
      netProfitDelta,
      netRoiPercent:
        combinedCost != null ? computeSpreadRoiPercent(combinedCost) : null,
      isActionable:
        combinedCost != null && combinedCost < 0.98 && (netProfitDelta ?? 0) > 0,
    },
    null,
    baseline,
    tradePrice
  );
}

function matrixFromTradePrice(tradePrice: number): BoxSpreadSnapshot {
  const opposingNoAsk = roundSpread4(1 - tradePrice);
  return {
    pmYesAsk: tradePrice,
    opposingNoAsk,
    opposingVenue: "polymarket",
    opposingVenueLabel: "Same-venue fallback",
    combinedCost: 1,
    impliedSumPercent: 100,
    netProfitDelta: 0,
    netRoiPercent: 0,
    isActionable: false,
    isExecutable: false,
    degraded: true,
    primaryQuoteSource: "trade_price",
    opposingQuoteSource: "complement",
  };
}

function resolveMatrixValues(
  arbDetails: ArbitrageOpportunity | null,
  boxSpread: BoxSpreadSnapshot | null,
  baseline: ExchangeBaselineSnapshot | null,
  tradePrice?: number | null,
  panelMode: ArbitragePanelMode = "standalone"
): BoxSpreadSnapshot | null {
  let matrix: BoxSpreadSnapshot | null = null;
  const baselineExchangeNoAsk = baseline
    ? exchangeNoAskFromBaseline(baseline)
    : null;

  if (boxSpread) {
    const allowExchangeOverride = boxSpread.opposingVenue !== "polymarket";
    const exchangeNoAsk =
      boxSpread.exchangeNoAsk ??
      baselineExchangeNoAsk ??
      (boxSpread.opposingVenue === "exchange" ? boxSpread.opposingNoAsk : null);
    matrix = {
      ...boxSpread,
      exchangeNoAsk,
      opposingNoAsk:
        allowExchangeOverride &&
        panelMode === "exchange" &&
        baselineExchangeNoAsk != null
          ? baselineExchangeNoAsk
          : (boxSpread.opposingNoAsk ??
            exchangeNoAsk ??
            boxSpread.kalshiNoAsk ??
            null),
      opposingVenue:
        allowExchangeOverride &&
        panelMode === "exchange" &&
        baselineExchangeNoAsk != null
          ? "exchange"
          : boxSpread.opposingVenue,
      opposingVenueLabel:
        allowExchangeOverride && panelMode === "exchange" && baseline
          ? baseline.label
          : boxSpread.opposingVenueLabel,
    };
  } else if (arbDetails) {
    matrix = matrixFromArbDetails(arbDetails);
  }

  if (matrix) {
    return finalizeMatrixSnapshot(matrix, arbDetails, baseline, tradePrice);
  }
  if (baseline) return matrixFromBaseline(baseline, tradePrice);
  if (tradePrice != null && Number.isFinite(tradePrice)) {
    return matrixFromTradePrice(tradePrice);
  }
  return matrixFromTradePrice(0.5);
}

function normalizeArbitrageApiResponse(data: ArbitrageApiResponse): {
  arbDetails: ArbitrageOpportunity | null;
  baseline: ExchangeBaselineSnapshot | null;
  boxSpread: BoxSpreadSnapshot | null;
} {
  const baseline = data.baseline ?? null;
  const exchangeNoAsk =
    data.exchangeNoAsk ??
    (baseline ? exchangeNoAskFromBaseline(baseline) : null);
  const spread = data.boxSpread ?? data.spread ?? null;

  let boxSpread: BoxSpreadSnapshot | null = spread;

  if (boxSpread && exchangeNoAsk != null) {
    boxSpread = {
      ...boxSpread,
      exchangeNoAsk,
      opposingNoAsk: boxSpread.opposingNoAsk ?? exchangeNoAsk,
      status: boxSpread.status ?? data.spreadStatus,
      statusMessage: boxSpread.statusMessage ?? data.spreadStatusMessage,
    };
  } else if (!boxSpread && baseline && exchangeNoAsk != null) {
    boxSpread = {
      pmYesAsk: null,
      opposingNoAsk: exchangeNoAsk,
      exchangeNoAsk,
      opposingVenue: "exchange",
      opposingVenueLabel: baseline.label,
      combinedCost: null,
      netProfitDelta: null,
      netRoiPercent: null,
      isActionable: false,
      status: data.spreadStatus ?? "AWAITING_PM_ORDER_BOOK",
      statusMessage:
        data.spreadStatusMessage ?? "Awaiting Polymarket order book depth",
    };
  } else if (spread) {
    boxSpread = {
      ...spread,
      status: spread.status ?? data.spreadStatus,
      statusMessage: spread.statusMessage ?? data.spreadStatusMessage,
    };
  }

  return {
    arbDetails: data.alert ?? data.arbitrage ?? null,
    baseline,
    boxSpread,
  };
}

function legRowLabel(leg: ArbitrageLeg): string {
  const venueName =
    leg.venue === "polymarket"
      ? "Polymarket"
      : leg.venue === "kalshi"
        ? "Kalshi"
        : "Exchange";
  const suffix =
    leg.venue === "kalshi" && leg.contractId
      ? ` · ${leg.contractId}`
      : "";
  return `${venueName} ${leg.side} Ask Price${suffix}`;
}

/** Build summary rows directly from the two execution legs (source of truth). */
function matrixFromExecutionLegs(
  arb: ArbitrageOpportunity
): {
  leg1Label: string;
  leg1Price: number;
  leg2Label: string;
  leg2Price: number;
  combinedCost: number;
  netProfitDelta: number;
  netRoiPercent: number;
  isActionable: boolean;
} | null {
  if (arb.legs.length < 2) return null;

  const leg1 = arb.legs[0];
  const leg2 = arb.legs[1];
  if (!leg1 || !leg2) return null;

  const leg1Price = leg1.askPrice;
  const leg2Price = leg2.askPrice;
  if (!Number.isFinite(leg1Price) || !Number.isFinite(leg2Price)) return null;

  const combinedCost = roundSpread4(leg1Price + leg2Price);
  const netProfitDelta = roundSpread4(1 - combinedCost);
  const netRoiPercent = computeSpreadRoiPercent(combinedCost);
  const isActionable = combinedCost < 0.98 && netProfitDelta > 0;

  return {
    leg1Label: legRowLabel(leg1),
    leg1Price,
    leg2Label: legRowLabel(leg2),
    leg2Price,
    combinedCost,
    netProfitDelta,
    netRoiPercent,
    isActionable,
  };
}

function formatSpreadEdgeValues(
  netProfitDelta: number | null | undefined,
  netRoiPercent: number | null | undefined,
  loading: boolean
): string {
  const delta = formatProfitDeltaOrSkeleton(netProfitDelta, loading);
  if (
    loading ||
    netRoiPercent == null ||
    !Number.isFinite(netRoiPercent)
  ) {
    return delta;
  }
  const roiSign = netRoiPercent >= 0 ? "+" : "";
  return `${delta} · ${roiSign}${netRoiPercent.toFixed(1)}% ROI`;
}

function formatPipelineAvgEvValue(
  netEvPercent: number,
  lowConfidence: boolean
): string {
  const formatted = formatEvPercent(netEvPercent);
  return `${lowConfidence ? `~${formatted}` : formatted} Avg EV`;
}

function pipelineEvHeaderBadgeClass(netEvPercent: number): string {
  if (netEvPercent > 0) {
    return "rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400";
  }
  if (netEvPercent < -0.05) {
    return "rounded bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-400";
  }
  return "rounded border border-pulse-border/80 bg-pulse-surface/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-pulse-label";
}

export type ArbitragePanelMode = "paired" | "exchange" | "standalone";

function resolvePanelBadge(params: {
  loading: boolean;
  isActionable: boolean;
  panelMode: ArbitragePanelMode;
  hasExchangeBaseline: boolean;
  spreadStatus?: string | null;
  spreadStatusMessage?: string | null;
}): { text: string; tone: "active" | "efficient" | "standalone" | "exchange" | "loading" | "awaiting" } {
  if (params.loading) {
    return { text: "Recalculating cross-venue spreads…", tone: "loading" };
  }
  if (params.isActionable) {
    return { text: "Active spread", tone: "active" };
  }
  if (
    params.spreadStatus &&
    params.spreadStatus !== "OK" &&
    params.spreadStatusMessage
  ) {
    return { text: params.spreadStatusMessage, tone: "awaiting" };
  }
  if (params.panelMode === "standalone" && params.hasExchangeBaseline) {
    return {
      text: "📦 Standalone Market (Exchange Consensus)",
      tone: "exchange",
    };
  }
  if (params.panelMode === "standalone") {
    return {
      text: "📦 Standalone Market (Single Venue Execution Tracking)",
      tone: "standalone",
    };
  }
  if (params.panelMode === "exchange" || params.hasExchangeBaseline) {
    return { text: "⚖️ Spreads are currently efficient", tone: "efficient" };
  }
  return { text: "⚖️ Spreads are currently efficient", tone: "efficient" };
}

function badgeClassName(tone: ReturnType<typeof resolvePanelBadge>["tone"]): string {
  if (tone === "active") {
    return "rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400";
  }
  if (tone === "loading") {
    return "rounded border border-pulse-border/80 bg-pulse-surface/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 animate-pulse";
  }
  if (tone === "awaiting") {
    return "rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200";
  }
  if (tone === "exchange") {
    return "rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300";
  }
  if (tone === "standalone") {
    return "rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200";
  }
  return "rounded border border-pulse-border/80 bg-pulse-surface/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-pulse-label";
}

function polymarketLegUrl(links: ArbitrageTradeLinks, tokenId: string): string {
  if (links.eventSlug) {
    return `https://polymarket.com/event/${links.eventSlug}`;
  }
  if (links.slug) {
    return `https://polymarket.com/event/${links.slug}`;
  }
  return `https://polymarket.com/?q=${encodeURIComponent(tokenId)}`;
}

function kalshiLegUrl(ticker: string): string {
  const series = ticker.split("-")[0]?.toLowerCase() ?? ticker.toLowerCase();
  return `https://kalshi.com/markets/${series}?op_market_ticker=${encodeURIComponent(ticker)}`;
}

function legActionUrl(leg: ArbitrageLeg, links: ArbitrageTradeLinks): string | null {
  if (leg.venue === "polymarket") {
    return polymarketLegUrl(links, leg.contractId);
  }
  if (leg.venue === "kalshi") {
    return kalshiLegUrl(leg.contractId);
  }
  return null;
}

function venueLabel(venue: ArbitrageLeg["venue"]): string {
  if (venue === "polymarket") return "Polymarket";
  if (venue === "kalshi") return "Kalshi";
  return "Exchange (Pinnacle/Betfair)";
}

function strategyLabel(strategy: ArbitrageOpportunity["strategy"]): string {
  if (strategy === "pm_yes_kalshi_no") return "PM YES + Kalshi NO";
  if (strategy === "kalshi_yes_pm_no") return "Kalshi YES + PM NO";
  return "PM vs Exchange Arb";
}

export function StandaloneMarketBadge({ className = "" }: { className?: string }) {
  return (
    <ArbitrageBoxSpreadMatrix
      arbDetails={null}
      arbLoading={false}
      arbError={null}
      boxSpread={null}
      panelMode="standalone"
      tradeLinks={{}}
      className={className}
    />
  );
}

interface ArbitrageBoxSpreadMatrixProps {
  arbDetails: ArbitrageOpportunity | null;
  arbLoading: boolean;
  arbError: string | null;
  tradeLinks: ArbitrageTradeLinks;
  baseline?: ExchangeBaselineSnapshot | null;
  boxSpread?: BoxSpreadSnapshot | null;
  panelMode?: ArbitragePanelMode;
  tradePrice?: number | null;
  pipelineData?: PipelineTradeEv | null;
  pipelineLoading?: boolean;
  className?: string;
}

function PipelineAverageEvPanel({
  pipelineData,
  pipelineLoading,
  tradePrice,
  arbLoading,
}: {
  pipelineData?: PipelineTradeEv | null;
  pipelineLoading: boolean;
  tradePrice?: number | null;
  arbLoading: boolean;
}) {
  const loading = pipelineLoading || arbLoading;
  const display = resolveDetailPanelDisplayEv(pipelineData, tradePrice);
  const { positive, negative } = display
    ? pipelineEvTone(display.netEvPercent)
    : { positive: false, negative: false };

  const valueText = loading
    ? "…"
    : display
      ? formatPipelineAvgEvValue(
          display.netEvPercent,
          display.lowConfidence
        )
      : "—";

  return (
    <div className="mt-3 rounded-lg border border-pulse-border/80 bg-black/40 px-3 py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className={badgeClassName(loading ? "loading" : "standalone")}>
          {loading ? "Loading EV" : "Pipeline Average EV"}
        </span>
        {display && !loading ? (
          <span className={pipelineEvHeaderBadgeClass(display.netEvPercent)}>
            {formatEvPercent(display.netEvPercent)} EV
          </span>
        ) : null}
      </div>

      <div className="space-y-2">
        {tradePrice != null && Number.isFinite(tradePrice) ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-pulse-surface/80 px-2.5 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-pulse-muted">
              Execution Price
            </p>
            <p className="text-sm font-bold text-white">
              {formatCents(tradePrice)}
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-pulse-surface/80 px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-pulse-muted">
            Average EV
          </p>
          <div className="flex items-center gap-2">
            <p
              className={`text-sm font-bold ${
                positive
                  ? "text-emerald-400"
                  : negative
                    ? "text-rose-400"
                    : loading
                      ? "text-zinc-500 animate-pulse"
                      : valueText === "—"
                        ? "text-zinc-500"
                        : "text-white"
              }`}
              title={
                display && pipelineData
                  ? pipelineEvTooltip(pipelineData, display)
                  : undefined
              }
            >
              {valueText}
            </p>
            {display?.lowConfidence && !loading ? (
              <span className="rounded bg-amber-500/20 px-1 text-[8px] font-bold uppercase text-amber-200/90">
                est
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function buildEdgeEmphasisRow(params: {
  pipelineDisplay: ReturnType<typeof resolveDetailPanelDisplayEv>;
  netProfitDelta: number | null;
  netRoiPercent: number | null;
  loading: boolean;
}): {
  label: string;
  value: string;
  emphasize: true;
  positive: boolean;
  negative: boolean;
} {
  const { pipelineDisplay, netProfitDelta, netRoiPercent, loading } = params;

  if (pipelineDisplay) {
    const tone = pipelineEvTone(pipelineDisplay.netEvPercent);
    return {
      label: "Average EV",
      value: formatPipelineAvgEvValue(
        pipelineDisplay.netEvPercent,
        pipelineDisplay.lowConfidence
      ),
      emphasize: true,
      positive: tone.positive,
      negative: tone.negative,
    };
  }

  return {
    label: "Net Spread Edge / ROI Delta",
    value: formatSpreadEdgeValues(netProfitDelta, netRoiPercent, loading),
    emphasize: true,
    positive: netProfitDelta != null && netProfitDelta > 0,
    negative: netProfitDelta != null && netProfitDelta < 0,
  };
}

function SpreadMatrixGrid({
  matrix,
  loading,
  isActionable,
  arbDetails,
  tradeLinks,
  panelMode,
  hasExchangeBaseline,
  pipelineDisplay,
  pipelineLoading,
}: {
  matrix: BoxSpreadSnapshot | null;
  loading: boolean;
  isActionable: boolean;
  arbDetails: ArbitrageOpportunity | null;
  tradeLinks: ArbitrageTradeLinks;
  panelMode: ArbitragePanelMode;
  hasExchangeBaseline: boolean;
  pipelineDisplay: ReturnType<typeof resolveDetailPanelDisplayEv>;
  pipelineLoading: boolean;
}) {
  const legsMatrix =
    arbDetails && arbDetails.legs.length >= 2
      ? matrixFromExecutionLegs(arbDetails)
      : null;

  const effectiveActionable = legsMatrix?.isActionable ?? isActionable;
  const netProfitDelta =
    legsMatrix?.netProfitDelta ?? matrix?.netProfitDelta ?? null;
  const netRoiPercent =
    legsMatrix?.netRoiPercent ?? matrix?.netRoiPercent ?? null;
  const edgeRow = buildEdgeEmphasisRow({
    pipelineDisplay,
    netProfitDelta,
    netRoiPercent,
    loading: loading || pipelineLoading,
  });
  const headerEvPercent = pipelineDisplay?.netEvPercent ?? null;

  const badge = resolvePanelBadge({
    loading,
    isActionable: effectiveActionable,
    panelMode,
    hasExchangeBaseline,
    spreadStatus: matrix?.status,
    spreadStatusMessage: matrix?.statusMessage,
  });

  type MatrixRow = {
    label: string;
    value: string;
    emphasize?: boolean;
    positive?: boolean;
    negative?: boolean;
  };

  const rows: MatrixRow[] = legsMatrix
    ? [
        {
          label: legsMatrix.leg1Label,
          value: formatCents(legsMatrix.leg1Price),
        },
        {
          label: legsMatrix.leg2Label,
          value: formatCents(legsMatrix.leg2Price),
        },
        {
          label: "Arbitrage Sum / Combined Cost",
          value: formatArbitrageSum(legsMatrix.combinedCost, loading),
          emphasize: true,
          positive: legsMatrix.combinedCost < 1,
          negative: false,
        },
        edgeRow,
      ]
    : [
        {
          label: "Polymarket YES Ask Price",
          value: formatCentsOrSkeleton(matrix?.pmYesAsk, loading),
        },
        {
          label: opposingVenueRowLabel(matrix),
          value: formatCentsOrSkeleton(matrix?.opposingNoAsk, loading),
        },
        {
          label: "Arbitrage Sum / Combined Cost",
          value: formatArbitrageSum(matrix?.combinedCost, loading),
          emphasize: true,
          positive:
            matrix?.combinedCost != null && matrix.combinedCost < 1,
          negative: false,
        },
        edgeRow,
      ];

  return (
    <div className="mt-3 rounded-lg border border-pulse-border/80 bg-black/40 px-3 py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className={badgeClassName(badge.tone)}>{badge.text}</span>
        {headerEvPercent != null && !loading && !pipelineLoading ? (
          <span className={pipelineEvHeaderBadgeClass(headerEvPercent)}>
            {formatEvPercent(headerEvPercent)} EV
          </span>
        ) : effectiveActionable && netRoiPercent != null && !pipelineDisplay ? (
          <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400">
            +{netRoiPercent.toFixed(1)}% ROI
          </span>
        ) : null}
      </div>

      {arbDetails && effectiveActionable ? (
        <p className="mb-3 text-xs font-bold uppercase tracking-wide text-white">
          {strategyLabel(arbDetails.strategy)}
        </p>
      ) : null}

      <div className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-pulse-surface/80 px-2.5 py-2"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wide text-pulse-muted">
              {row.label}
            </p>
            <p
              className={`text-sm font-bold ${
                row.emphasize && row.positive
                  ? "text-emerald-400"
                  : row.emphasize && row.negative
                    ? "text-rose-400"
                    : loading
                      ? "text-zinc-500 animate-pulse"
                      : "text-white"
              }`}
            >
              {row.value}
            </p>
          </div>
        ))}
      </div>

      {arbDetails && effectiveActionable ? (
        <div className="mt-3 space-y-2 border-t border-pulse-border/60 pt-3">
          <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-muted">
            Execution legs
          </p>
          {arbDetails.legs.map((leg) => {
            const href = legActionUrl(leg, tradeLinks);
            return (
              <div
                key={`${leg.venue}-${leg.side}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-pulse-surface/60 px-2.5 py-2"
              >
                <p className="text-xs text-pulse-label">
                  Buy {leg.side} · {venueLabel(leg.venue)}
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-white">
                    {formatCents(leg.askPrice)}
                  </span>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-400 transition-colors hover:bg-emerald-500/20"
                    >
                      Trade →
                    </a>
                  ) : (
                    <span className="rounded border border-pulse-border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-pulse-muted">
                      Consensus
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default function ArbitrageBoxSpreadMatrix({
  arbDetails,
  arbLoading,
  arbError,
  tradeLinks,
  baseline = null,
  boxSpread = null,
  panelMode = "standalone",
  tradePrice = null,
  pipelineData = null,
  pipelineLoading = false,
  className = "",
}: ArbitrageBoxSpreadMatrixProps) {
  const pipelineDisplay = resolveDetailPanelDisplayEv(pipelineData, tradePrice);
  const matrix = resolveMatrixValues(
    arbDetails,
    boxSpread,
    baseline,
    tradePrice,
    panelMode
  );
  const legsMatrix =
    arbDetails && arbDetails.legs.length >= 2
      ? matrixFromExecutionLegs(arbDetails)
      : null;
  const isActionable =
    legsMatrix?.isActionable ??
    ((arbDetails != null && arbDetails.netProfitPerUnit > 0) ||
      (matrix?.isActionable ?? false));
  const isExchangeMode =
    matrix?.opposingVenue !== "polymarket" &&
    (panelMode === "exchange" ||
      matrix?.opposingVenue === "exchange" ||
      arbDetails?.strategy === "pm_vs_exchange_arb" ||
      arbDetails?.secondaryVenue === "exchange" ||
      baseline != null);
  const isStandalonePanel = panelMode === "standalone";

  return (
    <section
      className={`rounded-lg border border-pulse-border bg-pulse-surface/80 px-3 py-3 ${className}`}
      data-testid="arbitrage-box-spread-matrix"
    >
      <p className="text-[10px] font-bold uppercase tracking-wide text-pulse-muted">
        {isStandalonePanel ? "Average EV" : "Arbitrage Box Spread"}
        {isExchangeMode && !isStandalonePanel ? " · Exchange Consensus" : ""}
        {isStandalonePanel ? " · Pipeline" : ""}
      </p>

      {arbError && !isStandalonePanel ? (
        <div className="mt-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-400">
            Arbitrage scan error
          </p>
          <p className="mt-1 text-sm text-rose-300">{arbError}</p>
        </div>
      ) : null}

      {isStandalonePanel ? (
        <PipelineAverageEvPanel
          pipelineData={pipelineData}
          pipelineLoading={pipelineLoading}
          tradePrice={tradePrice}
          arbLoading={arbLoading}
        />
      ) : (
        <SpreadMatrixGrid
          matrix={matrix}
          loading={arbLoading}
          isActionable={isActionable}
          arbDetails={arbDetails}
          tradeLinks={tradeLinks}
          panelMode={panelMode}
          hasExchangeBaseline={baseline != null}
          pipelineDisplay={pipelineDisplay}
          pipelineLoading={pipelineLoading}
        />
      )}

      {baseline && !isStandalonePanel ? (
        <div className="mt-2 rounded-md border border-pulse-border/80 bg-pulse-surface/60 px-2.5 py-2 text-xs text-pulse-label">
          <p className="font-semibold text-white">Exchange baseline</p>
          <p className="mt-1">
            YES bid{" "}
            {formatCentsOrSkeleton(baseline.yesBid, arbLoading)} · YES ask{" "}
            {formatCentsOrSkeleton(baseline.yesAsk, arbLoading)} · NO ask{" "}
            {formatCentsOrSkeleton(
              baseline.exchangeNoAsk ?? exchangeNoAskFromBaseline(baseline),
              arbLoading
            )}
          </p>
          <p className="mt-0.5 text-pulse-muted">
            {baseline.label} ({baseline.bookmakerCount}+ books)
          </p>
        </div>
      ) : null}
    </section>
  );
}

interface TradeArbitrageSectionProps {
  pipelineData: PipelineTradeEv | null | undefined;
  pipelineLoading?: boolean;
  tradeLinks: ArbitrageTradeLinks;
  pmTokenId?: string | null;
  kalshiTicker?: string | null;
  title?: string | null;
  /** Trade execution / current price (0–1). */
  tradePrice?: number | null;
  /** Alias for tradePrice (e.g. live ask). */
  tradeAsk?: number | null;
  isSportsMarket?: boolean;
  className?: string;
  enabled?: boolean;
}

export function TradeArbitrageSection({
  pipelineData,
  pipelineLoading = false,
  tradeLinks,
  pmTokenId,
  kalshiTicker,
  title,
  tradePrice = null,
  tradeAsk = null,
  isSportsMarket,
  className = "",
  enabled = true,
}: TradeArbitrageSectionProps) {
  const effectiveTradePrice =
    tradePrice ?? tradeAsk ?? pipelineData?.pmMid ?? null;
  const mappingPairKey = resolveMappingPairKey(pipelineData);
  const isPaired = isPairedPipelineTrade(pipelineData);
  const sports =
    isSportsMarket ??
    (title ? inferMarketCategory(title) === "SPORTS" : false);
  const tokenId = pmTokenId ?? pipelineData?.tokenId ?? null;
  const ticker = kalshiTicker ?? pipelineData?.kalshiTicker ?? null;
  const canScanExchange = sports && !!tokenId;
  const canScanKalshiOnly = !!ticker && !tokenId;
  const panelMode: ArbitragePanelMode = isPaired
    ? "paired"
    : canScanExchange
      ? "exchange"
      : canScanKalshiOnly
        ? "exchange"
        : "standalone";

  const [arbDetails, setArbDetails] = useState<ArbitrageOpportunity | null>(
    null
  );
  const [baseline, setBaseline] = useState<ExchangeBaselineSnapshot | null>(null);
  const [boxSpread, setBoxSpread] = useState<BoxSpreadSnapshot | null>(null);
  const [arbLoading, setArbLoading] = useState(false);
  const [arbError, setArbError] = useState<string | null>(null);

  const combinedLoading = pipelineLoading || arbLoading;
  const shouldFetchArb =
    enabled &&
    !pipelineLoading &&
    (!!mappingPairKey || !!tokenId || !!ticker);

  useEffect(() => {
    if (!enabled) {
      setArbDetails(null);
      setBaseline(null);
      setBoxSpread(null);
      setArbLoading(false);
      setArbError(null);
      return;
    }

    if (pipelineLoading) return;

    if (!shouldFetchArb) {
      setArbLoading(false);
      return;
    }

    let cancelled = false;
    setArbDetails(null);
    setBaseline(null);
    setBoxSpread(null);
    setArbLoading(true);
    setArbError(null);

    void (async () => {
      const params = new URLSearchParams();
      // Unpaired sports markets must hit the tokenId API path (not pairKey).
      if (isPaired && mappingPairKey) {
        params.set("pairKey", mappingPairKey);
        if (tokenId) params.set("tokenId", tokenId);
      } else if (tokenId) {
        params.set("tokenId", tokenId);
      } else if (ticker) {
        params.set("kalshiTicker", ticker);
      }
      if (
        effectiveTradePrice != null &&
        Number.isFinite(effectiveTradePrice)
      ) {
        params.set("tradePrice", String(effectiveTradePrice));
      }
      if (tradeLinks.slug) params.set("slug", tradeLinks.slug);
      if (title) params.set("title", title);

      if (!params.has("pairKey") && !params.has("tokenId") && !params.has("kalshiTicker")) {
        if (!cancelled) setArbLoading(false);
        return;
      }

      const url = `/api/ev/arbitrage?${params.toString()}`;
      try {
        console.log("[TradeArbitrageSection] fetching arbitrage", {
          url,
          mappingPairKey,
          tokenId,
          sports,
          pipelineStatus: pipelineData?.status,
        });

        const res = await fetch(url);
        const data = (await res.json()) as ArbitrageApiResponse;

        console.log("[TradeArbitrageSection] API response keys:", Object.keys(data));
        console.log("[TradeArbitrageSection] sportsbook fields:", {
          exchangeNoAsk: data.exchangeNoAsk,
          spreadStatus: data.spreadStatus,
          spreadStatusMessage: data.spreadStatusMessage,
          baselineExchangeNoAsk: data.baseline?.exchangeNoAsk,
          spreadExchangeNoAsk: data.boxSpread?.exchangeNoAsk ?? data.spread?.exchangeNoAsk,
          spreadOpposingNoAsk: data.boxSpread?.opposingNoAsk ?? data.spread?.opposingNoAsk,
          opposingVenue: data.boxSpread?.opposingVenue ?? data.spread?.opposingVenue,
        });

        if (!res.ok) {
          const message =
            data.error ?? `Arbitrage API returned HTTP ${res.status}`;
          console.error("Arbitrage fetch failed:", message, data);
          if (!cancelled) {
            const normalized = normalizeArbitrageApiResponse(data);
            setArbDetails(normalized.arbDetails);
            setBaseline(normalized.baseline);
            setBoxSpread(normalized.boxSpread);
            setArbError(message);
          }
          return;
        }

        if (!cancelled) {
          const normalized = normalizeArbitrageApiResponse(data);
          console.log("[TradeArbitrageSection] normalized payload:", {
            hasBaseline: !!normalized.baseline,
            spreadStatus:
              normalized.boxSpread?.status ?? data.spreadStatus ?? null,
            spreadStatusMessage:
              normalized.boxSpread?.statusMessage ??
              data.spreadStatusMessage ??
              null,
            exchangeNoAsk:
              normalized.boxSpread?.exchangeNoAsk ??
              normalized.baseline?.exchangeNoAsk ??
              data.exchangeNoAsk,
            opposingNoAsk: normalized.boxSpread?.opposingNoAsk,
            combinedCost: normalized.boxSpread?.combinedCost,
          });
          setArbDetails(normalized.arbDetails);
          setBaseline(normalized.baseline);
          setBoxSpread(normalized.boxSpread);
          setArbError(null);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Arbitrage fetch failed";
        console.error("Arbitrage fetch failed:", err);
        if (!cancelled) {
          setArbDetails(null);
          setBaseline(null);
          setBoxSpread(null);
          setArbError(message);
        }
      } finally {
        if (!cancelled) setArbLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    shouldFetchArb,
    isPaired,
    mappingPairKey,
    tokenId,
    ticker,
    sports,
    effectiveTradePrice,
    pipelineLoading,
    pipelineData?.status,
    tradeLinks.slug,
    title,
  ]);

  return (
    <ArbitrageBoxSpreadMatrix
      arbDetails={arbDetails}
      arbLoading={combinedLoading}
      arbError={arbError}
      baseline={baseline}
      boxSpread={boxSpread}
      panelMode={panelMode}
      tradePrice={effectiveTradePrice}
      tradeLinks={tradeLinks}
      pipelineData={pipelineData}
      pipelineLoading={pipelineLoading}
      className={className}
    />
  );
}
