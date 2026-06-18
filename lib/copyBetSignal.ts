import type { MarketSummary, TradeSummary } from "@/lib/polymarket";
import {
  calculateCopyVerdict,
  getDirectionSignal,
  getLiquiditySignal,
  getPriceSignal,
  getSizeSignal,
  getTimingSignal,
  type WhaleSignal,
} from "@/lib/whaleSignals";

export function getCopyBetButtonConfig(verdict: string, side: string) {
  if (side === "SELL") {
    return {
      text: "View This Market on Polymarket →",
      className: "bg-slate-700 hover:bg-slate-600 text-white",
    };
  }

  if (verdict === "Strong Copy Signal") {
    return {
      text: "Copy This Bet on Polymarket →",
      className: "bg-green-600 hover:bg-green-500 text-white",
    };
  }

  if (verdict === "Worth Considering") {
    return {
      text: "Consider This Bet on Polymarket →",
      className: "bg-blue-600 hover:bg-blue-500 text-white",
    };
  }

  if (verdict === "Proceed With Caution") {
    return {
      text: "View This Market on Polymarket →",
      className: "bg-yellow-600 hover:bg-yellow-500 text-white",
    };
  }

  return {
    text: "View This Market on Polymarket →",
    className: "bg-slate-700 hover:bg-slate-600 text-white",
  };
}

export function buildCopySignals(
  trade: TradeSummary,
  currentProbability: number | null,
  matchedMarket?: MarketSummary | null
): WhaleSignal[] {
  return [
    getSizeSignal(trade.size),
    getPriceSignal(trade.price, currentProbability, trade.side),
    getTimingSignal(trade.timestamp),
    getLiquiditySignal(
      matchedMarket?.spread ?? null,
      matchedMarket?.volume ?? 0
    ),
    getDirectionSignal(trade.price, trade.side),
  ];
}

export function getCopyVerdict(
  trade: TradeSummary,
  currentProbability: number | null,
  matchedMarket?: MarketSummary | null
) {
  const signals = buildCopySignals(trade, currentProbability, matchedMarket);
  return calculateCopyVerdict(signals);
}
