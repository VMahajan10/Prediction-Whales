import type { MarketSummary, TradeSummary } from "@/lib/polymarket";
import { TRACK_RECORD_RELIABILITY_FLOOR } from "@/lib/polymarket";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import {
  calculateCopyVerdict,
  getDirectionSignal,
  getLiquiditySignal,
  getPriceSignal,
  getSizeSignal,
  getTimingSignal,
  type CopyVerdict,
  type WhaleSignal,
} from "@/lib/whaleSignals";

/** Minimum trade-level edge in probability units (2¢) for a strong copy signal. */
export const STRONG_COPY_MIN_TRADE_EV = 0.02;

export function tradeEvPercentToProbability(evPercent: number | null | undefined): number | null {
  if (evPercent == null || !Number.isFinite(evPercent)) return null;
  return evPercent / 100;
}

export function meetsStrongCopyEvThreshold(
  tradeEvPercent: number | null | undefined,
  tradeNetEv?: number | null
): boolean {
  if (tradeNetEv != null && Number.isFinite(tradeNetEv)) {
    return tradeNetEv > STRONG_COPY_MIN_TRADE_EV;
  }
  const prob = tradeEvPercentToProbability(tradeEvPercent);
  return prob != null && prob > STRONG_COPY_MIN_TRADE_EV;
}

export interface TrackRecordCopyContext {
  proxyWallet?: string;
  loading?: boolean;
  unavailable?: boolean;
  closedCount?: number;
  hasEnoughHistory?: boolean;
  winRate?: number | null;
  roi?: number | null;
}

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

  if (verdict === "Promising Bet, Unproven Trader") {
    return {
      text: "Research Before Copying →",
      className: "bg-yellow-600 hover:bg-yellow-500 text-white",
    };
  }

  if (verdict === "Worth Considering") {
    return {
      text: "Consider This Bet on Polymarket →",
      className: "bg-blue-600 hover:bg-blue-500 text-white",
    };
  }

  if (
    verdict === "Unproven Trader — Limited Track Record" ||
    verdict === "Proceed With Caution"
  ) {
    return {
      text: "View This Market on Polymarket →",
      className: "bg-orange-600 hover:bg-orange-500 text-white",
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

function formatRoiPct(roi: number | null | undefined): string {
  if (roi == null) return "—";
  const sign = roi >= 0 ? "+" : "";
  return `${sign}${roi.toFixed(1)}%`;
}

export function getTrackRecordSignal(
  ctx: TrackRecordCopyContext
): WhaleSignal {
  if (!ctx.proxyWallet) {
    return {
      emoji: "❓",
      label: "Trader history unknown",
      plain:
        "Wallet not linked yet — we can't assess this trader's closed-bet history.",
      positive: null,
    };
  }

  if (ctx.loading) {
    return {
      emoji: "⏳",
      label: "Checking track record",
      plain: "Loading this trader's closed-bet history…",
      positive: null,
    };
  }

  if (ctx.unavailable) {
    return {
      emoji: "⚠️",
      label: "Track record unavailable",
      plain: "Not enough history to assess this trader.",
      positive: false,
    };
  }

  const closedCount = ctx.closedCount ?? 0;

  if (closedCount === 0) {
    return {
      emoji: "⚠️",
      label: "No closed bet history",
      plain:
        "This trader has 0 closed bets on record. Not enough history to assess this trader — copy signals are capped regardless of how good this trade looks.",
      positive: false,
    };
  }

  if (!ctx.hasEnoughHistory || closedCount < TRACK_RECORD_RELIABILITY_FLOOR) {
    return {
      emoji: "⚠️",
      label: "Limited track record",
      plain: `This trader has ${closedCount} closed bet${closedCount === 1 ? "" : "s"} — below our reliability floor (${TRACK_RECORD_RELIABILITY_FLOOR}). Not enough history to assess skill.`,
      positive: false,
    };
  }

  const winRate = ctx.winRate;
  const roi = ctx.roi;
  const positiveTrack =
    winRate != null && winRate >= 50 && roi != null && roi >= 0;

  if (positiveTrack) {
    return {
      emoji: "✅",
      label: "Proven track record",
      plain: `${closedCount} closed bets · ${Math.round(winRate)}% win rate · ${formatRoiPct(roi)} ROI. Strong copy signals require ≥${TRACK_RECORD_RELIABILITY_FLOOR} bets, ≥50% win rate, and trade EV above +2%.`,
      positive: true,
    };
  }

  return {
    emoji: "⚠️",
    label: "Weak track record",
    plain: `${closedCount} closed bets on record, but win rate (${winRate != null ? `${Math.round(winRate)}%` : "—"}) or ROI (${formatRoiPct(roi)}) doesn't confirm skill. Trade quality alone isn't enough for a strong copy signal.`,
    positive: false,
  };
}

function isTrackRecordInsufficient(ctx: TrackRecordCopyContext): boolean {
  if (ctx.loading || !ctx.proxyWallet || ctx.unavailable) return true;
  const closedCount = ctx.closedCount ?? 0;
  return closedCount === 0 || !ctx.hasEnoughHistory;
}

function isProvenPositiveTrack(ctx: TrackRecordCopyContext): boolean {
  if (isTrackRecordInsufficient(ctx)) return false;
  const closedCount = ctx.closedCount ?? 0;
  const winRate = ctx.winRate;
  const roi = ctx.roi;
  return (
    closedCount >= TRACK_RECORD_RELIABILITY_FLOOR &&
    winRate != null &&
    winRate >= 50 &&
    roi != null &&
    roi >= 0
  );
}

export function getTradeEvSignal(
  tradeEvPercent: number | null | undefined,
  tradeNetEv?: number | null
): WhaleSignal {
  if (tradeEvPercent == null && tradeNetEv == null) {
    return {
      emoji: "📊",
      label: "Trade EV unavailable",
      plain:
        "No cross-market or AI true-EV reference for this contract yet — strong copy requires EV > +2%.",
      positive: null,
    };
  }

  const meets = meetsStrongCopyEvThreshold(tradeEvPercent, tradeNetEv);
  const label =
    tradeEvPercent != null
      ? formatEvPercent(tradeEvPercent)
      : tradeNetEv != null
        ? `${tradeNetEv >= 0 ? "+" : ""}${(tradeNetEv * 100).toFixed(1)}%`
        : "—";

  if (meets) {
    return {
      emoji: "✅",
      label: "Positive trade EV",
      plain: `${label} expected value vs fair reference — above our +2% floor for strong copy signals.`,
      positive: true,
    };
  }

  return {
    emoji: "⚠️",
    label: "Insufficient trade EV",
    plain: `${label} expected value — strong copy requires EV above +2% after fees.`,
    positive: false,
  };
}

/** Caps trade-only verdict using trader track-record quality and trade EV. */
export function applyTrackRecordCap(
  tradeVerdict: CopyVerdict,
  ctx: TrackRecordCopyContext,
  tradeSignals: WhaleSignal[],
  tradeEvPercent?: number | null,
  tradeNetEv?: number | null
): CopyVerdict {
  const positiveCount = tradeSignals.filter((s) => s.positive === true).length;
  const tradeWasStrong = tradeVerdict.verdict === "Strong Copy Signal";
  const tradeWasWorth = tradeVerdict.verdict === "Worth Considering";
  const tradeLooksGood = tradeWasStrong || positiveCount >= 3;
  const hasStrongEv = meetsStrongCopyEvThreshold(tradeEvPercent, tradeNetEv);

  if (isTrackRecordInsufficient(ctx)) {
    if (tradeLooksGood) {
      return {
        verdict: "Promising Bet, Unproven Trader",
        verdictColor: "yellow",
        verdictEmoji: "🟡",
      };
    }
    if (tradeWasStrong || tradeWasWorth) {
      return {
        verdict: "Unproven Trader — Limited Track Record",
        verdictColor: "orange",
        verdictEmoji: "🟠",
      };
    }
    return tradeVerdict;
  }

  if (tradeWasStrong && !isProvenPositiveTrack(ctx)) {
    return {
      verdict: "Worth Considering",
      verdictColor: "yellow",
      verdictEmoji: "🟡",
    };
  }

  if (tradeWasStrong && isProvenPositiveTrack(ctx) && !hasStrongEv) {
    return {
      verdict: "Worth Considering",
      verdictColor: "yellow",
      verdictEmoji: "🟡",
    };
  }

  if (tradeWasStrong && isProvenPositiveTrack(ctx) && hasStrongEv) {
    return tradeVerdict;
  }

  return tradeVerdict;
}

export function getCopyVerdict(
  trade: TradeSummary,
  currentProbability: number | null,
  matchedMarket?: MarketSummary | null,
  trackContext?: TrackRecordCopyContext,
  tradeEvPercent?: number | null,
  tradeNetEv?: number | null
) {
  const tradeSignals = buildCopySignals(
    trade,
    currentProbability,
    matchedMarket
  );
  const tradeVerdict = calculateCopyVerdict(tradeSignals);

  if (!trackContext) {
    return tradeVerdict;
  }

  return applyTrackRecordCap(
    tradeVerdict,
    trackContext,
    tradeSignals,
    tradeEvPercent,
    tradeNetEv
  );
}

export function getCopySignalsAndVerdict(
  trade: TradeSummary,
  currentProbability: number | null,
  matchedMarket: MarketSummary | null | undefined,
  trackContext: TrackRecordCopyContext,
  tradeEvPercent?: number | null,
  tradeNetEv?: number | null
): { signals: WhaleSignal[]; verdict: CopyVerdict } {
  const tradeSignals = buildCopySignals(
    trade,
    currentProbability,
    matchedMarket
  );
  const evSignal = getTradeEvSignal(tradeEvPercent, tradeNetEv);
  const trackSignal = getTrackRecordSignal(trackContext);
  const tradeVerdict = calculateCopyVerdict(tradeSignals);
  const verdict = applyTrackRecordCap(
    tradeVerdict,
    trackContext,
    tradeSignals,
    tradeEvPercent,
    tradeNetEv
  );

  return {
    signals: [...tradeSignals, evSignal, trackSignal],
    verdict,
  };
}
