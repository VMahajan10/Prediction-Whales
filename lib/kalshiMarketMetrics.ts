import { computeEvPercent } from "@/lib/crossMarketEv";
import type {
  KalshiMarketDetail,
  KalshiMarketFlow,
  KalshiOrderBook,
  KalshiTradeDetail,
} from "@/lib/kalshiDetail";
import { kalshiYesMidFromMarket } from "@/lib/kalshiDetail";

export interface OrderBookFairValue {
  tradePrice: number;
  currentMid: number;
  evPercent: number;
  outcome: "Yes" | "No";
}

export interface OrderBookDepthTotals {
  yesContracts: number;
  noContracts: number;
  totalContracts: number;
}

export interface LiquidityMetrics {
  spreadCents: number | null;
  spreadQuality: "tight" | "moderate" | "wide" | null;
  depth: OrderBookDepthTotals | null;
  volume24h: number | null;
  openInterest: number | null;
}

/** Outcome-aware mid from live market quotes (Yes or No side). */
export function kalshiOutcomeMid(
  market: KalshiMarketDetail,
  outcome: "Yes" | "No"
): number | null {
  if (outcome === "Yes") {
    return kalshiYesMidFromMarket(market);
  }
  if (market.noBid != null && market.noAsk != null && market.noBid > 0) {
    return (market.noBid + market.noAsk) / 2;
  }
  const yesMid = kalshiYesMidFromMarket(market);
  return yesMid != null ? 1 - yesMid : null;
}

export function computeOrderBookFairValue(
  trade: KalshiTradeDetail,
  market: KalshiMarketDetail | null
): OrderBookFairValue | null {
  if (!market) return null;
  const currentMid = kalshiOutcomeMid(market, trade.outcome);
  if (currentMid == null || currentMid <= 0 || trade.price <= 0) return null;

  const evRaw = computeEvPercent(trade.price, currentMid);
  if (evRaw == null) return null;

  return {
    tradePrice: trade.price,
    currentMid,
    evPercent: Math.round(evRaw * 10) / 10,
    outcome: trade.outcome,
  };
}

export function sumOrderBookDepth(
  orderbook: KalshiOrderBook | null
): OrderBookDepthTotals | null {
  if (!orderbook) return null;
  const yesContracts = orderbook.yes.reduce((s, l) => s + l.size, 0);
  const noContracts = orderbook.no.reduce((s, l) => s + l.size, 0);
  return {
    yesContracts,
    noContracts,
    totalContracts: yesContracts + noContracts,
  };
}

export function spreadQualityFromCents(
  spreadCents: number | null
): LiquidityMetrics["spreadQuality"] {
  if (spreadCents == null) return null;
  if (spreadCents <= 3) return "tight";
  if (spreadCents <= 8) return "moderate";
  return "wide";
}

export function spreadQualityLabel(
  quality: NonNullable<LiquidityMetrics["spreadQuality"]>
): string {
  switch (quality) {
    case "tight":
      return "Tight spread — liquid market, easy to enter and exit.";
    case "moderate":
      return "Moderate spread — tradable, but slippage may matter on larger sizes.";
    case "wide":
      return "Wide spread — thin market; entering or exiting may cost more.";
  }
}

export function computeLiquidityMetrics(
  market: KalshiMarketDetail | null,
  orderbook: KalshiOrderBook | null
): LiquidityMetrics {
  const spreadCents =
    market?.yesBid != null && market?.yesAsk != null
      ? (market.yesAsk - market.yesBid) * 100
      : null;

  return {
    spreadCents,
    spreadQuality: spreadQualityFromCents(spreadCents),
    depth: sumOrderBookDepth(orderbook),
    volume24h: market?.volume24h ?? null,
    openInterest: market?.openInterest ?? null,
  };
}

export function flowLeanLabel(flow: KalshiMarketFlow): string | null {
  if (flow.largeTradeCount === 0 || flow.totalLargeVolume <= 0) return null;
  if (flow.yesPct >= 60) return "money leaning YES";
  if (flow.noPct >= 60) return "money leaning NO";
  return "mixed — no clear side";
}
