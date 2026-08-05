import {
  meetsFeedTradeEvThreshold,
  meetsProductFeedStakeThreshold,
} from "@/lib/feedQualification";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { resolvePipelineEvForWhale } from "@/lib/pipelineEvClient";
import { tradeToWhale, type WhaleTrade } from "@/lib/whaleTrades";

/**
 * Structural input so this stays client-safe — importing `lib/kalshiTrades`
 * would pull the shadow-log writer into the browser bundle.
 */
export interface KalshiFeedTradeInput {
  id: string;
  title: string;
  outcome: string;
  side?: "BUY" | "SELL";
  price: number;
  usdNotional: number;
  timestamp: number;
  ticker?: string;
}

/**
 * Kalshi rows carry no wallet or trader identity — Kalshi's public API exposes
 * none, and profiling members is prohibited (see docs/Kalshi Whale Attribution
 * Audit.md). `proxyWallet` and `whaleIdentity` stay unset by design.
 */
export function kalshiFeedTradeToWhale(
  trade: KalshiFeedTradeInput
): WhaleTrade {
  return tradeToWhale(
    {
      id: trade.id,
      title: trade.title,
      side: trade.side ?? (trade.outcome === "Yes" ? "BUY" : "SELL"),
      outcome: trade.outcome,
      price: trade.price,
      size: trade.usdNotional,
      timestamp: trade.timestamp,
      transactionHash: "",
    },
    {
      detectedAt: trade.timestamp * 1000,
      isLive: true,
      usdNotional: trade.usdNotional,
      source: "kalshi",
      ticker: trade.ticker,
    }
  );
}

/**
 * Kalshi product-feed stake gate — flat $500 minimum, no wallet checks.
 */
export function isKalshiTradeStakeCandidate(trade: WhaleTrade): boolean {
  return (
    trade.source === "kalshi" &&
    meetsProductFeedStakeThreshold(trade.usdNotional)
  );
}

/**
 * Kalshi product-feed gate — stake + trade EV >= +3.0% when EV is known.
 * Null / unmapped EV is admitted so the client can render immediately and
 * hydrate via /api/ev/trades (same progressive path as Polymarket candidates).
 */
export function isKalshiTradeEligibleForFeed(
  trade: WhaleTrade,
  pipelineEvIndex: Map<string, PipelineTradeEv>
): boolean {
  if (!isKalshiTradeStakeCandidate(trade)) return false;

  const pipeline = resolvePipelineEvForWhale(pipelineEvIndex, trade);
  const tradeEvPercent = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    pipeline
  );

  if (tradeEvPercent == null) return true;
  return meetsFeedTradeEvThreshold(tradeEvPercent);
}
