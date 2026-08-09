import type { FeedTrade } from "@/lib/feedTradeTypes";
import { kalshiFeedTradeToWhale } from "@/lib/feed/kalshiFeedTrades";
import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import { tradeToWhale, type WhaleTrade } from "@/lib/whaleTrades";

export type RecentHydratedTrade = FeedTrade & {
  netEvPercent?: number | null;
};

function resolveHydratedStakeNotional(trade: RecentHydratedTrade): number {
  return trade.stake_notional ?? trade.usdNotional;
}

function resolveHydratedEvPercent(trade: RecentHydratedTrade): number | null {
  if (trade.netEvPercent != null && Number.isFinite(trade.netEvPercent)) {
    return trade.netEvPercent;
  }
  if (trade.ev != null && Number.isFinite(trade.ev)) {
    return trade.ev * 100;
  }
  return null;
}

/** Map DB-seeded recent trades into whale-feed rows (client-safe). */
export function recentTradeToWhale(trade: RecentHydratedTrade): WhaleTrade {
  const stakeNotional = resolveHydratedStakeNotional(trade);
  const netEvPercent = resolveHydratedEvPercent(trade);

  if (trade.source === "kalshi") {
    return kalshiFeedTradeToWhale(
      {
        id: trade.id,
        title: trade.title,
        outcome: trade.outcome,
        side: trade.side,
        price: trade.price,
        usdNotional: stakeNotional,
        timestamp: trade.timestamp,
        ticker: trade.ticker,
        selectionLabel: trade.selectionLabel,
        category: trade.category,
      },
      {
        isLive: false,
        netEvPercent,
      }
    );
  }

  const whale = tradeToWhale(
    {
      id: trade.id,
      title: trade.title,
      side: trade.side,
      outcome: trade.outcome,
      price: trade.price,
      size: trade.size,
      timestamp: trade.timestamp,
      transactionHash: trade.transactionHash ?? "",
      slug: trade.slug,
      assetId: trade.assetId,
    },
    {
      detectedAt: trade.timestamp * 1000,
      isLive: false,
      usdNotional: stakeNotional,
      source: "polymarket",
    }
  );

  const marketTranslation = translateWhaleTradeMarket(whale) ?? undefined;

  return {
    ...whale,
    platform: "POLYMARKET",
    usdNotional: stakeNotional,
    marketTranslation,
    netEvPercent,
    averageEv: netEvPercent,
    category: trade.category ?? undefined,
  };
}
