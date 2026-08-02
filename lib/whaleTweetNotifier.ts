import type { FeedTrade } from "@/lib/kalshiTrades";
import {
  isWhaleNotional,
  tradeToWhale,
  type WhaleTrade,
} from "@/lib/whaleTrades";
import {
  sendWhaleTweet,
  type WhaleTweetPayload,
} from "@/lib/sendWhaleTweet";

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
): WhaleTweetPayload {
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
 * Kalshi trades are never tweeted — public posting is Polymarket-only.
 */
export function notifyWhaleTradeIfEligible(trade: WhaleTrade): void {
  if (trade.source === "kalshi") return;
  if (!isWhaleNotional(trade.usdNotional)) return;

  const key = whaleTradeDedupKey(trade);
  if (tweetedTradeKeys.has(key)) return;
  tweetedTradeKeys.add(key);

  void sendWhaleTweet(whaleTradeToTweetPayload(trade)).catch((error) => {
    console.error(
      "[whaleTweetNotifier] sendWhaleTweet error:",
      error instanceof Error ? error.message : error
    );
  });
}

/**
 * Kalshi feed hook — intentionally a no-op.
 * Shadow logging happens in `fetchKalshiTrades` / `kalshi_shadow_trades`.
 * X-agent posting remains blocked by `KALSHI_PUBLIC_POSTING_DISABLED`.
 */
export function notifyKalshiFeedTradeIfEligible(
  _trade: FeedTrade,
  _detectedAt = Date.now()
): void {
  return;
}
