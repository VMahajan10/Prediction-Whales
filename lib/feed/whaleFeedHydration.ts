import type { FeedTrade } from "@/lib/feedTradeTypes";
import { kalshiFeedTradeToWhale } from "@/lib/feed/kalshiFeedTrades";
import { translateWhaleTradeMarket } from "@/lib/marketTranslator";
import { tradeToWhale, type WhaleTrade } from "@/lib/whaleTrades";

export type RecentHydratedTrade = FeedTrade & {
  netEvPercent?: number | null;
};

/** Map DB-seeded recent trades into whale-feed rows (client-safe). */
export function recentTradeToWhale(trade: RecentHydratedTrade): WhaleTrade {
  if (trade.source === "kalshi") {
    return kalshiFeedTradeToWhale(
      {
        id: trade.id,
        title: trade.title,
        outcome: trade.outcome,
        side: trade.side,
        price: trade.price,
        usdNotional: trade.usdNotional,
        timestamp: trade.timestamp,
        ticker: trade.ticker,
        selectionLabel: trade.selectionLabel,
        category: trade.category,
      },
      {
        isLive: false,
        netEvPercent: trade.netEvPercent ?? null,
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
      usdNotional: trade.usdNotional,
      source: "polymarket",
    }
  );

  const marketTranslation = translateWhaleTradeMarket(whale) ?? undefined;
  const netEvPercent = trade.netEvPercent ?? null;

  return {
    ...whale,
    platform: "POLYMARKET",
    marketTranslation,
    netEvPercent,
    averageEv: netEvPercent,
    category: trade.category ?? undefined,
  };
}
