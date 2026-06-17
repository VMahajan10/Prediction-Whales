import type { MarketSummary, TradeSummary } from "@/lib/polymarket";
import type { SocketTrade } from "@/lib/usePolymarketSocket";

export type SignalImpact = "high" | "medium" | "low";

export interface WhaleSignal {
  icon: string;
  label: string;
  detail: string;
  impact: SignalImpact;
}

export interface WhaleScore {
  score: number;
  signals: WhaleSignal[];
  verdict: string;
  color: "green" | "yellow" | "orange" | "red";
  emoji: string;
}

export interface MarketContext {
  currentProbability: number | null;
  priceAtTrade: number;
  delta: number;
}

const RELATED_TRADE_WINDOW_SEC = 60;

export function scoreWhale(trade: TradeSummary): WhaleScore {
  let score = 0;
  const signals: WhaleSignal[] = [];

  if (trade.size >= 10000) {
    score += 40;
    signals.push({
      icon: "💰",
      label: "Massive position size",
      detail: `$${trade.size.toLocaleString()} — top tier whale`,
      impact: "high",
    });
  } else if (trade.size >= 5000) {
    score += 30;
    signals.push({
      icon: "💰",
      label: "Large position size",
      detail: `$${trade.size.toLocaleString()} — serious capital`,
      impact: "high",
    });
  } else if (trade.size >= 1000) {
    score += 20;
    signals.push({
      icon: "💰",
      label: "Significant position",
      detail: `$${trade.size.toLocaleString()} — above average`,
      impact: "medium",
    });
  } else {
    score += 10;
    signals.push({
      icon: "💰",
      label: "Moderate position",
      detail: `$${trade.size.toLocaleString()}`,
      impact: "low",
    });
  }

  if (trade.price > 0.85) {
    score += 20;
    signals.push({
      icon: "🎯",
      label: "High conviction YES bet",
      detail: `Buying at ${(trade.price * 100).toFixed(1)}¢ — paying premium for certainty`,
      impact: "high",
    });
  } else if (trade.price < 0.15) {
    score += 20;
    signals.push({
      icon: "🎯",
      label: "High conviction NO bet",
      detail: `Buying at ${(trade.price * 100).toFixed(1)}¢ — strong contrarian signal`,
      impact: "high",
    });
  } else if (trade.price > 0.4 && trade.price < 0.6) {
    score += 10;
    signals.push({
      icon: "🪙",
      label: "Uncertain market entry",
      detail: `Buying at ${(trade.price * 100).toFixed(1)}¢ — near 50/50`,
      impact: "medium",
    });
  }

  if (trade.side === "BUY") {
    score += 20;
    signals.push({
      icon: "📈",
      label: "Opening new position",
      detail: "BUY order — whale is entering the market",
      impact: "high",
    });
  } else {
    score += 5;
    signals.push({
      icon: "📉",
      label: "Closing or shorting",
      detail: "SELL order — whale may be taking profit or hedging",
      impact: "medium",
    });
  }

  const q = trade.title.toLowerCase();
  if (
    q.includes("president") ||
    q.includes("election") ||
    q.includes("fed") ||
    q.includes("bitcoin") ||
    q.includes("world cup")
  ) {
    score += 20;
    signals.push({
      icon: "🌍",
      label: "High-profile market",
      detail: "Trading in a major market — whale has strong conviction",
      impact: "high",
    });
  } else {
    score += 10;
    signals.push({
      icon: "📊",
      label: "Niche market trade",
      detail: "Smaller market — whale may have inside edge",
      impact: "medium",
    });
  }

  let verdict: string;
  let color: WhaleScore["color"];
  let emoji: string;

  if (score >= 80) {
    verdict = "Strong Follow Signal";
    color = "green";
    emoji = "🟢";
  } else if (score >= 60) {
    verdict = "Worth Watching";
    color = "yellow";
    emoji = "🟡";
  } else if (score >= 40) {
    verdict = "Proceed with Caution";
    color = "orange";
    emoji = "🟠";
  } else {
    verdict = "Low Signal";
    color = "red";
    emoji = "🔴";
  }

  return { score, signals, verdict, color, emoji };
}

export function getScoreDescription(score: number): string {
  if (score >= 80) {
    return "This whale is placing a large, high-conviction bet on a major market. Worth tracking closely.";
  }
  if (score >= 60) {
    return "This whale shows notable conviction. The position is worth monitoring for follow-up activity.";
  }
  if (score >= 40) {
    return "This whale trade has mixed signals. Worth monitoring, but not a clear follow signal.";
  }
  return "This trade shows limited signals of informed trading. Could be routine portfolio management.";
}

export function getWhaleFollowAdvice(score: number): string {
  if (score >= 80) {
    return `This whale is showing strong conviction signals. Large position size combined with a directional bet on a major market suggests informed trading.

✅ Consider: Looking at this market yourself
✅ Consider: Researching why someone would bet this heavily
⚠️  Remember: Even informed whales are wrong. Never risk more than you can afford to lose.`;
  }
  if (score >= 60) {
    return `This whale is showing moderate conviction. The position is notable but not exceptional.

✅ Consider: Adding this market to your watchlist
✅ Consider: Waiting to see if more whales follow in the same direction
⚠️  Remember: One trade is not a trend.`;
  }
  if (score >= 40) {
    return `This whale trade has mixed signals. The position size is significant but other factors suggest caution.

✅ Consider: Monitoring this market for follow-up
❌ Avoid: Blindly copying this trade
⚠️  Remember: This could be hedging, not conviction.`;
  }
  return `This trade shows limited signals of informed trading. Could be routine portfolio management.

❌ Avoid: Following this trade
✅ Consider: Looking for stronger whale signals
⚠️  Remember: Not all large trades are meaningful.`;
}

export function fuzzyMatchTitle(
  tradeTitle: string,
  marketQuestion: string
): boolean {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const t = normalize(tradeTitle);
  const q = normalize(marketQuestion);
  if (t.includes(q.slice(0, Math.min(30, q.length)))) return true;
  if (q.includes(t.slice(0, Math.min(30, t.length)))) return true;
  const qWords = q.split(/\s+/).filter((w) => w.length > 4);
  const matches = qWords.filter((w) => t.includes(w)).length;
  return matches >= Math.min(3, qWords.length);
}

export function findTradeByHash(
  trades: TradeSummary[],
  hash: string
): TradeSummary | null {
  const decoded = decodeURIComponent(hash).toLowerCase();
  return (
    trades.find((t) => t.transactionHash.toLowerCase() === decoded) ?? null
  );
}

export function findSocketTradeByHash(
  trades: SocketTrade[],
  hash: string
): SocketTrade | null {
  const decoded = decodeURIComponent(hash).toLowerCase();
  return (
    trades.find((t) => t.transactionHash.toLowerCase() === decoded) ?? null
  );
}

/** Adapt a live WS trade to TradeSummary (size = USD notional). */
export function socketTradeToTradeSummary(t: SocketTrade): TradeSummary {
  return {
    id: t.transactionHash || t.id,
    title: t.title,
    side: t.side,
    outcome: t.outcome,
    price: t.price,
    size: t.usdNotional,
    timestamp: t.timestamp,
    transactionHash: t.transactionHash,
    assetId: t.assetId,
    eventSlug: t.eventSlug,
    slug: t.slug,
    conditionId: t.conditionId,
  };
}

export function findRelatedTrades(
  trades: TradeSummary[],
  trade: TradeSummary
): TradeSummary[] {
  return trades.filter(
    (t) =>
      t.id !== trade.id &&
      Math.abs(t.timestamp - trade.timestamp) <= RELATED_TRADE_WINDOW_SEC
  );
}

export function findMarketForTrade(
  trade: TradeSummary,
  markets: MarketSummary[]
): MarketSummary | null {
  return markets.find((m) => fuzzyMatchTitle(trade.title, m.question)) ?? null;
}

export function buildMarketContext(
  trade: TradeSummary,
  matchedMarket: MarketSummary | null
): MarketContext {
  const priceAtTrade = trade.price;
  const currentProbability = matchedMarket?.probability ?? null;
  const delta =
    currentProbability != null
      ? (currentProbability - priceAtTrade) * 100
      : 0;

  return { currentProbability, priceAtTrade, delta };
}

export function truncateTxHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

export function formatTradeDateTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export const SCORE_BORDER_COLORS: Record<WhaleScore["color"], string> = {
  green: "border-green-500",
  yellow: "border-yellow-500",
  orange: "border-orange-500",
  red: "border-red-500",
};

export const IMPACT_BADGE_STYLES: Record<
  SignalImpact,
  { label: string; className: string }
> = {
  high: { label: "High Impact", className: "bg-red-500/20 text-red-400" },
  medium: {
    label: "Medium Impact",
    className: "bg-yellow-500/20 text-yellow-400",
  },
  low: { label: "Low Impact", className: "bg-slate-700 text-slate-400" },
};
