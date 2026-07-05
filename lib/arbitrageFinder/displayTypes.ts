import type { ArbStakePlan, ArbitrageWindow } from "@/lib/arbitrageFinder/types";

export type ArbDisplayMode =
  | "cross_venue_lock"
  | "single_venue_box"
  | "exchange_proxy_box";

export type QuoteSource =
  | "order_book"
  | "p_true"
  | "consensus"
  | "trade_price"
  | "mid_proxy"
  | "complement"
  | "universal_prior";

export interface ArbitrageDisplayLeg {
  venue: "polymarket" | "kalshi" | "exchange";
  side: "YES" | "NO";
  contractId: string;
  askPrice: number;
  source: QuoteSource;
}

export interface ArbitrageDisplaySnapshot {
  mode: ArbDisplayMode;
  label: string;
  impliedSumPercent: number;
  inverseOddsSumPercent: number;
  roiPercent: number;
  isActionable: boolean;
  /** UI edge rule: the two-leg implied sum is strictly below 100%. */
  hasSub100Edge: boolean;
  /** True only when both legs are current executable quotes. */
  isExecutable: boolean;
  combinedCost: number;
  degraded: boolean;
  legs: [ArbitrageDisplayLeg, ArbitrageDisplayLeg];
  scannedAt: string;
  crossVenueWindow?: ArbitrageWindow | null;
  stakePlan?: ArbStakePlan;
}

export interface ResolveArbitrageDisplayInput {
  source?: "polymarket" | "kalshi" | "auto";
  pmTokenId?: string | null;
  kalshiTicker?: string | null;
  /** Literal YES/NO or a selected outcome label such as an esports team. */
  tradeOutcomeSide?: string | null;
  tradePrice?: number | null;
  title?: string | null;
  slug?: string | null;
  pmMid?: number | null;
  stakeUsd?: number | null;
  prefer?: "auto" | "cross_venue" | "single_venue";
}

export function hasSub100ArbitrageEdge(
  impliedSumPercent: number
): boolean {
  return Number.isFinite(impliedSumPercent) && impliedSumPercent < 100;
}

/** Defensive client fallback for transient API/network failures. */
export function buildNeutralArbitrageSnapshot(params: {
  venue: "polymarket" | "kalshi";
  contractId: string;
  referencePrice?: number | null;
}): ArbitrageDisplaySnapshot {
  const validReference =
    params.referencePrice != null &&
    Number.isFinite(params.referencePrice) &&
    params.referencePrice > 0 &&
    params.referencePrice < 1;
  const yesAsk = validReference ? params.referencePrice! : 0.5;
  const noAsk = 1 - yesAsk;

  return {
    mode: "single_venue_box",
    label: "Arbitrage Sum",
    impliedSumPercent: 100,
    inverseOddsSumPercent: 100,
    roiPercent: 0,
    isActionable: false,
    hasSub100Edge: false,
    isExecutable: false,
    combinedCost: 1,
    degraded: true,
    legs: [
      {
        venue: params.venue,
        side: "YES",
        contractId: params.contractId,
        askPrice: yesAsk,
        source: validReference ? "trade_price" : "universal_prior",
      },
      {
        venue: params.venue,
        side: "NO",
        contractId: params.contractId,
        askPrice: noAsk,
        source: "complement",
      },
    ],
    scannedAt: new Date().toISOString(),
    crossVenueWindow: null,
  };
}
