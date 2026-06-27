import type { TradeSummary } from "@/lib/polymarket";
import { MIN_WHALE_USD } from "@/lib/whaleTrades";

export { MIN_WHALE_USD };

export interface TradeClass {
  label: string;
  emoji: string;
  color: "purple" | "blue" | "cyan" | "green" | "slate";
  description: string;
  percentile: string;
  tier: number;
  barFill: number;
  /** True when notional clears the platform whale threshold (≥$500). */
  qualifiesAsWhale: boolean;
}

export const TRADE_TIERS: TradeClass[] = [
  {
    label: "Minnow",
    emoji: "🦐",
    color: "slate",
    description:
      "Small retail bet (under $100). Casual or experimental — below our $500 whale threshold.",
    percentile: "bottom 80%",
    tier: 0,
    barFill: 0,
    qualifiesAsWhale: false,
  },
  {
    label: "Fish",
    emoji: "🐟",
    color: "green",
    description:
      "Active retail size ($100–$499). Engaged trader, but still below the $500 whale threshold.",
    percentile: "top 20%",
    tier: 1,
    barFill: 2,
    qualifiesAsWhale: false,
  },
  {
    label: "Whale",
    emoji: "🐋",
    color: "cyan",
    description:
      "Qualifies as a whale trade (≥$500). Clears our tracker threshold — meaningful size worth watching.",
    percentile: "top 10%",
    tier: 2,
    barFill: 5,
    qualifiesAsWhale: true,
  },
  {
    label: "Large",
    emoji: "🐬",
    color: "cyan",
    description:
      "Large whale trade ($1k–$4.9k). Well above the $500 minimum — strong conviction signal.",
    percentile: "top 5%",
    tier: 3,
    barFill: 7,
    qualifiesAsWhale: true,
  },
  {
    label: "Major",
    emoji: "⚡",
    color: "blue",
    description:
      "Major whale trade ($5k–$9.9k). Serious money — these trades often move market prices.",
    percentile: "top 1%",
    tier: 4,
    barFill: 9,
    qualifiesAsWhale: true,
  },
  {
    label: "Mega",
    emoji: "🐋🐋🐋",
    color: "purple",
    description:
      "Mega whale ($10k+). Institutional-level size — extremely rare and market-moving.",
    percentile: "top 0.1%",
    tier: 5,
    barFill: 10,
    qualifiesAsWhale: true,
  },
];

export const TIER_RANGES = [
  { label: "Minnow", emoji: "🦐", range: "$1-99", qualifiesAsWhale: false },
  { label: "Fish", emoji: "🐟", range: "$100-499", qualifiesAsWhale: false },
  { label: "Whale", emoji: "🐋", range: "$500-999", qualifiesAsWhale: true },
  { label: "Large", emoji: "🐬", range: "$1k-4.9k", qualifiesAsWhale: true },
  { label: "Major", emoji: "⚡", range: "$5k-9.9k", qualifiesAsWhale: true },
  { label: "Mega", emoji: "🐋", range: "$10k+", qualifiesAsWhale: true },
] as const;

export const TIER_COLOR_CLASSES: Record<TradeClass["color"], string> = {
  purple: "bg-purple-500/20 text-purple-300 border-purple-500/40",
  blue: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  cyan: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40",
  green: "bg-green-500/20 text-green-300 border-green-500/40",
  slate: "bg-slate-700 text-slate-300 border-slate-600",
};

export function getTradeTierIndex(size: number): number {
  if (size >= 10_000) return 5;
  if (size >= 5_000) return 4;
  if (size >= 1_000) return 3;
  if (size >= MIN_WHALE_USD) return 2;
  if (size >= 100) return 1;
  return 0;
}

export function getTradeClass(size: number): TradeClass {
  const tier = TRADE_TIERS[getTradeTierIndex(size)];
  const emojiSuffix =
    tier.tier >= 4 ? " 🐋🐋" : tier.qualifiesAsWhale ? " 🐋" : "";
  return {
    ...tier,
    label: `${tier.label}${emojiSuffix}`,
  };
}

export function getPlainEnglishOutcomeLabel(outcome: string): string {
  const normalized = outcome.toLowerCase();
  if (normalized === "yes") return "this outcome WILL happen";
  if (normalized === "no") return "this outcome WON'T happen";
  return `"${outcome}" will happen`;
}

export function getPlainEnglishOutcome(trade: TradeSummary): string {
  return getPlainEnglishOutcomeLabel(trade.outcome);
}

export function getTradeDirectionInsight(
  delta: number,
  side: "BUY" | "SELL"
): { text: string; className: string } | null {
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  if (direction === "flat") return null;
  if (direction === "up" && side === "BUY") {
    return {
      text: "📈 Price moved in the trader's favor since this trade",
      className: "text-green-400",
    };
  }
  if (direction === "down" && side === "BUY") {
    return {
      text: "📉 Price moved against the trader since this trade",
      className: "text-red-400",
    };
  }
  if (direction === "up" && side === "SELL") {
    return {
      text: "📉 Price rose after they sold — they may have sold too early",
      className: "text-yellow-400",
    };
  }
  if (direction === "down" && side === "SELL") {
    return {
      text: "📈 Price fell after they sold — the sell looks correct",
      className: "text-green-400",
    };
  }
  return null;
}

/** Plain-language implied probability — not a headcount of opinions. */
export function formatImpliedProbabilitySummary(price: number): string {
  const pct = price * 100;
  const rounded =
    pct >= 10 ? pct.toFixed(0) : pct >= 1 ? pct.toFixed(1) : pct.toFixed(2);
  return `The market prices this at ~${rounded}% likely`;
}

export function getPriceAnalysis(price: number): string {
  const cents = price * 100;

  if (cents < 10) {
    return "Extremely cheap shares. The market thinks this is very unlikely. Buying here is a big longshot — but the payout is massive if correct.";
  }
  if (cents < 25) {
    return "Cheap shares. The market thinks this is unlikely. High risk, high reward territory. One piece of surprising news could dramatically change this price.";
  }
  if (cents < 40) {
    return "Moderate discount. The market leans NO but isn't certain. Buyers here think the market is too pessimistic.";
  }
  if (cents < 60) {
    return "Near 50/50. The market is genuinely uncertain. These are the most interesting markets — both sides think they have an edge.";
  }
  if (cents < 75) {
    return "Moderate premium. The market leans YES. Buyers are paying up for what they see as a likely outcome.";
  }
  if (cents < 90) {
    return "Expensive shares. Market thinks this is likely. Lower payout but higher win rate — more like collecting insurance premiums than gambling.";
  }
  return "Very expensive shares. Near-certain outcome according to the market. Buying here is low risk, low reward — you're essentially lending money at a small interest rate.";
}

export function getPriceMovementMessage(
  delta: number,
  side: "BUY" | "SELL"
): string {
  if (Math.abs(delta) < 0.5) {
    return "Price hasn't moved since this trade. The market hasn't reacted yet — or this trade wasn't big enough to move it.";
  }
  if (delta > 0 && side === "BUY") {
    return `📈 Price moved UP ${delta.toFixed(1)}% since this BUY. The trader is currently in profit on paper.`;
  }
  if (delta < 0 && side === "BUY") {
    return `📉 Price moved DOWN ${Math.abs(delta).toFixed(1)}% since this BUY. The trader is currently at a loss.`;
  }
  if (delta > 0 && side === "SELL") {
    return `📈 Price moved UP ${delta.toFixed(1)}% after this SELL. If they sold to cut losses, they sold too early.`;
  }
  if (delta < 0 && side === "SELL") {
    return `📉 Price moved DOWN ${Math.abs(delta).toFixed(1)}% after this SELL. Selling looks like the right call.`;
  }
  return "Price has shifted since this trade.";
}

export function getQuickTakeForTrade(
  size: number,
  side: "BUY" | "SELL",
  price: number
): string {
  const sizeClass = getTradeClass(size).label;
  const direction =
    side === "BUY"
      ? "believes this WILL happen"
      : "is exiting their position";
  const priceContext =
    price < 0.3
      ? "longshot territory"
      : price > 0.7
        ? "heavy favorite"
        : "contested market";

  const conviction =
    side === "BUY" && size >= MIN_WHALE_USD
      ? "The position size qualifies as a whale trade and suggests conviction, not casual betting."
      : "Monitor for follow-up activity in this market.";

  return `A ${sizeClass} trader ${direction} at ${(price * 100).toFixed(1)}% — ${priceContext}. ${conviction}`;
}

export function getQuickTake(trade: TradeSummary): string {
  return getQuickTakeForTrade(trade.size, trade.side, trade.price);
}
