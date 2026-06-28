import {
  outcomeMatchId,
  parseKalshiGameTicker,
  parsePmMoneylineSlug,
  snapshotGameEv,
  type OutcomeBooks,
} from "@/lib/crossMarketEv";
import type { TradeEvInput } from "@/lib/resolveTradeCrossMarketEv";

export const ARBITRAGE_EV_THRESHOLD_PCT = 2;

export interface SyntheticArbitrageResult {
  /** Best actionable cross-venue synthetic EV (%). */
  combinedEvPercent: number | null;
  evIfBuyOnPm: number | null;
  evIfBuyOnKalshi: number | null;
  gap: number | null;
  qualifies: boolean;
  reason: "ok" | "no_match" | "below_threshold" | "missing_price";
}

function lookupEntry(
  trade: TradeEvInput,
  index: Map<string, OutcomeBooks>
): OutcomeBooks | null {
  if (trade.source === "polymarket" && trade.slug) {
    const parsed = parsePmMoneylineSlug(trade.slug);
    if (parsed?.outcome) {
      return index.get(outcomeMatchId(parsed.game, parsed.outcome)) ?? null;
    }
  }

  if (trade.source === "kalshi" && trade.ticker) {
    const parsed = parseKalshiGameTicker(trade.ticker);
    if (parsed?.outcome) {
      return index.get(outcomeMatchId(parsed.game, parsed.outcome)) ?? null;
    }
  }

  return null;
}

/** Combined synthetic arbitrage EV from Polymarket + Kalshi mids on the same matched game. */
export function computeSyntheticArbitrageEv(
  entry: OutcomeBooks,
  nowSec: number = Math.floor(Date.now() / 1000)
): SyntheticArbitrageResult {
  const snap = snapshotGameEv(entry, nowSec);
  const pmEv =
    snap.evIfBuyOnPm.reason === "ok" ? snap.evIfBuyOnPm.ev : null;
  const kalshiEv =
    snap.evIfBuyOnKalshi.reason === "ok" ? snap.evIfBuyOnKalshi.ev : null;

  if (snap.pmMid == null || snap.kalshiMid == null) {
    return {
      combinedEvPercent: null,
      evIfBuyOnPm: pmEv,
      evIfBuyOnKalshi: kalshiEv,
      gap: snap.gap,
      qualifies: false,
      reason: "missing_price",
    };
  }

  const positive = [pmEv, kalshiEv].filter(
    (ev): ev is number => ev != null && ev > 0
  );
  const combinedEvPercent =
    positive.length > 0 ? Math.max(...positive) : null;

  if (combinedEvPercent == null) {
    return {
      combinedEvPercent: null,
      evIfBuyOnPm: pmEv,
      evIfBuyOnKalshi: kalshiEv,
      gap: snap.gap,
      qualifies: false,
      reason: "no_match",
    };
  }

  const qualifies = combinedEvPercent > ARBITRAGE_EV_THRESHOLD_PCT;
  return {
    combinedEvPercent,
    evIfBuyOnPm: pmEv,
    evIfBuyOnKalshi: kalshiEv,
    gap: snap.gap,
    qualifies,
    reason: qualifies ? "ok" : "below_threshold",
  };
}

export function resolveSyntheticArbitrageForTrade(
  trade: TradeEvInput,
  index: Map<string, OutcomeBooks>
): SyntheticArbitrageResult {
  const entry = lookupEntry(trade, index);
  if (!entry) {
    return {
      combinedEvPercent: null,
      evIfBuyOnPm: null,
      evIfBuyOnKalshi: null,
      gap: null,
      qualifies: false,
      reason: "no_match",
    };
  }
  return computeSyntheticArbitrageEv(entry);
}
