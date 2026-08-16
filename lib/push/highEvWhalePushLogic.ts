import type { WhaleTrade } from "@/lib/whaleTrades";
import {
  meetsFeedTradeEvThreshold,
  meetsProductFeedStakeThreshold,
} from "@/lib/feedQualification";

function resolveTradeEvPercent(trade: WhaleTrade): number | null {
  const candidates = [trade.netEvPercent, trade.grossEvPercent, trade.averageEv];
  for (const value of candidates) {
    if (value != null && Number.isFinite(value)) return value;
  }
  return null;
}

export function shouldSendHighEvWhalePush(trade: WhaleTrade): boolean {
  if (!meetsProductFeedStakeThreshold(trade.usdNotional)) return false;
  return meetsFeedTradeEvThreshold(resolveTradeEvPercent(trade));
}

export function buildWhalePushPayload(trade: WhaleTrade): {
  title: string;
  body: string;
  data: Record<string, string>;
} {
  const tradeEvPercent = resolveTradeEvPercent(trade);
  const evLabel =
    tradeEvPercent != null ? ` · +${tradeEvPercent.toFixed(1)}% EV` : "";
  const side =
    trade.source === "kalshi"
      ? trade.outcome
      : `${trade.side} ${trade.outcome}`.trim();
  const detailPath = buildWhaleDetailPath(trade);

  return {
    title: "🐋 High-EV whale trade",
    body: `${formatUsd(trade.usdNotional)} on ${trade.title} (${side})${evLabel}`,
    data: {
      type: "whale_trade",
      tradeId: trade.id,
      source: trade.source,
      path: detailPath,
      ...(trade.transactionHash
        ? { transactionHash: trade.transactionHash }
        : {}),
    },
  };
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function buildWhaleDetailPath(trade: WhaleTrade): string {
  if (trade.source === "kalshi") {
    const base = `/whales/kalshi/${encodeURIComponent(trade.id)}`;
    return trade.ticker
      ? `${base}?ticker=${encodeURIComponent(trade.ticker)}`
      : base;
  }

  const key = trade.transactionHash || trade.id;
  return key ? `/whales/${encodeURIComponent(key)}` : "/";
}
