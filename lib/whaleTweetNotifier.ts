import type { FeedTrade } from "@/lib/kalshiTrades";
import {
  isWhaleNotional,
  tradeToWhale,
  type WhaleTrade,
} from "@/lib/whaleTrades";
import {
  triggerTweetWhaleTrade,
  type TweetWhaleTradePayload,
} from "@/lib/tweetWhaleTrade";

const tweetedTradeKeys = new Set<string>();

export function whaleTradeDedupKey(trade: {
  source?: string;
  id: string;
  transactionHash?: string;
}): string {
  return `${trade.source ?? "polymarket"}:${trade.transactionHash || trade.id}`;
}

export function whaleTradeToTweetPayload(
  trade: WhaleTrade
): TweetWhaleTradePayload {
  const whaleAddress =
    trade.proxyWallet?.trim() ||
    (trade.source === "kalshi" ? "Anonymous" : "Unknown");

  const side = trade.source === "kalshi" ? trade.outcome : trade.side;

  return {
    tradeId: trade.id,
    whaleAddress,
    amount: trade.usdNotional,
    marketName: trade.title,
    side,
  };
}

export function feedTradeToWhaleTrade(
  trade: FeedTrade,
  detectedAt = Date.now()
): WhaleTrade {
  return tradeToWhale(
    {
      id: trade.id,
      title: trade.title,
      side: trade.side,
      outcome: trade.outcome,
      price: trade.price,
      size: trade.usdNotional,
      timestamp: trade.timestamp,
      transactionHash: "",
    },
    {
      detectedAt,
      isLive: true,
      usdNotional: trade.usdNotional,
      source: "kalshi",
      ticker: trade.ticker,
    }
  );
}

/**
 * When a trade meets whale criteria, fire-and-forget a tweet via the bot API.
 * Dedupes by source + trade id/hash for the lifetime of the server process.
 */
export function notifyWhaleTradeIfEligible(trade: WhaleTrade): void {
  if (!isWhaleNotional(trade.usdNotional)) return;

  const key = whaleTradeDedupKey(trade);
  if (tweetedTradeKeys.has(key)) return;
  tweetedTradeKeys.add(key);

  void triggerTweetWhaleTrade(whaleTradeToTweetPayload(trade));
}

export function notifyKalshiFeedTradeIfEligible(
  trade: FeedTrade,
  detectedAt = Date.now()
): void {
  notifyWhaleTradeIfEligible(feedTradeToWhaleTrade(trade, detectedAt));
}
