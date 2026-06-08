import type { TradeSummary } from "@/lib/polymarket";

export interface TradeClass {
  label: string;
  emoji: string;
  color: "purple" | "blue" | "cyan" | "green" | "slate";
  description: string;
  percentile: string;
  tier: number;
  barFill: number;
}

export const TRADE_TIERS: TradeClass[] = [
  {
    label: "Shrimp",
    emoji: "🦐",
    color: "slate",
    description:
      "Small retail bet. Under $100 — casual or experimental trading.",
    percentile: "bottom 80%",
    tier: 0,
    barFill: 0,
  },
  {
    label: "Fish",
    emoji: "🐟",
    color: "green",
    description:
      "Active retail trader. $100-$999 bets are common among engaged participants.",
    percentile: "top 20%",
    tier: 1,
    barFill: 4,
  },
  {
    label: "Dolphin",
    emoji: "🐬",
    color: "cyan",
    description:
      "Above average trader. Not a whale but still meaningful — these traders often have more information than casual bettors.",
    percentile: "top 5%",
    tier: 2,
    barFill: 8,
  },
  {
    label: "Whale",
    emoji: "🐋",
    color: "blue",
    description:
      "Major player. $5,000+ bets represent serious conviction. Worth tracking closely.",
    percentile: "top 1%",
    tier: 3,
    barFill: 9,
  },
  {
    label: "Mega Whale",
    emoji: "🐋🐋🐋",
    color: "purple",
    description:
      "Extremely rare. This is institutional-level money. These trades can single-handedly move market prices.",
    percentile: "top 0.1%",
    tier: 4,
    barFill: 10,
  },
];

export const TIER_RANGES = [
  { label: "Shrimp", emoji: "🦐", range: "$1-99" },
  { label: "Fish", emoji: "🐟", range: "$100-999" },
  { label: "Dolphin", emoji: "🐬", range: "$1k-4.9k" },
  { label: "Whale", emoji: "🐋", range: "$5k-9.9k" },
  { label: "Mega", emoji: "🐋", range: "$10k+" },
];

export const TIER_COLOR_CLASSES: Record<TradeClass["color"], string> = {
  purple: "bg-purple-500/20 text-purple-300 border-purple-500/40",
  blue: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  cyan: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40",
  green: "bg-green-500/20 text-green-300 border-green-500/40",
  slate: "bg-slate-700 text-slate-300 border-slate-600",
};

export function getTradeClass(size: number): TradeClass {
  if (size >= 10000) {
    return { ...TRADE_TIERS[4], label: "Mega Whale 🐋🐋🐋" };
  }
  if (size >= 5000) {
    return { ...TRADE_TIERS[3], label: "Whale 🐋🐋" };
  }
  if (size >= 1000) {
    return { ...TRADE_TIERS[2], label: "Dolphin 🐬" };
  }
  if (size >= 100) {
    return { ...TRADE_TIERS[1], label: "Fish 🐟" };
  }
  return { ...TRADE_TIERS[0], label: "Shrimp 🦐" };
}

export function getTradeTierIndex(size: number): number {
  if (size >= 10000) return 4;
  if (size >= 5000) return 3;
  if (size >= 1000) return 2;
  if (size >= 100) return 1;
  return 0;
}

export function getPlainEnglishOutcome(trade: TradeSummary): string {
  const outcome = trade.outcome.toLowerCase();
  if (outcome === "yes") return "this outcome WILL happen";
  if (outcome === "no") return "this outcome WON'T happen";
  return `"${trade.outcome}" will happen`;
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
    return "Moderate discount. The market leans NO but isn't certain. Buyers here think the crowd is too pessimistic.";
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

export function getQuickTake(trade: TradeSummary): string {
  const sizeClass = getTradeClass(trade.size).label;
  const direction =
    trade.side === "BUY"
      ? "believes this WILL happen"
      : "is exiting their position";
  const priceContext =
    trade.price < 0.3
      ? "longshot territory"
      : trade.price > 0.7
        ? "heavy favorite"
        : "contested market";

  const conviction =
    trade.side === "BUY" && trade.size >= 1000
      ? "The position size suggests conviction, not casual betting."
      : "Monitor for follow-up activity in this market.";

  return `A ${sizeClass} trader ${direction} at ${(trade.price * 100).toFixed(1)}% — ${priceContext}. ${conviction}`;
}
