import { entryPriceEvPercent } from "@/lib/feedTradeEv";

export type KalshiOutcomeSide = "yes" | "no";

/** Normalize Yes/No outcome labels or Kalshi taker_side to a contract side. */
export function normalizeKalshiOutcomeSide(
  outcome?: string | null,
  takerSide?: string | null
): KalshiOutcomeSide {
  const raw = (outcome ?? takerSide ?? "yes").trim().toLowerCase();
  return raw === "no" ? "no" : "yes";
}

/**
 * Kalshi order-book mids are stored in YES probability space. Convert to the
 * traded outcome's fair probability (NO fair ≈ 1 − YES mid).
 */
export function kalshiMidForOutcome(
  yesMid: number | null | undefined,
  outcome: KalshiOutcomeSide
): number | null {
  if (yesMid == null || !Number.isFinite(yesMid)) return null;
  if (outcome === "yes") return yesMid;
  return 1 - yesMid;
}

/** ROI % vs fair probability when entry and fair value share the same outcome space. */
export function kalshiOutcomeEntryEvPercent(
  fairProb: number,
  entryPrice: number
): number | null {
  return entryPriceEvPercent(fairProb, entryPrice);
}

export interface KalshiOutcomeFairMids {
  pmMid: number | null;
  kalshiMid: number | null;
  pMarket: number | null;
  pTrue: number | null;
}

/** Re-express pipeline mids in the traded outcome's probability space. */
export function pipelineFairMidsForKalshiOutcome(
  pipeline: {
    pmMid?: number | null;
    kalshiMid?: number | null;
    pMarket?: number | null;
    pTrue?: number | null;
  },
  outcome: KalshiOutcomeSide
): KalshiOutcomeFairMids {
  return {
    pmMid: kalshiMidForOutcome(pipeline.pmMid, outcome),
    kalshiMid: kalshiMidForOutcome(pipeline.kalshiMid, outcome),
    pMarket: kalshiMidForOutcome(pipeline.pMarket, outcome),
    pTrue: kalshiMidForOutcome(pipeline.pTrue, outcome),
  };
}
