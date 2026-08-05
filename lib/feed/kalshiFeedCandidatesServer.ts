import "server-only";

import { meetsProductFeedStakeThreshold } from "@/lib/feedQualification";
import { fetchKalshiTrades, type FeedTrade } from "@/lib/kalshiTrades";

/**
 * Transient Kalshi product-feed candidates — stake-qualified only, no EV gate.
 * Raw Kalshi API data is not persisted (Kalshi Developer Agreement §3.1).
 */
export async function collectKalshiFeedCandidates(
  minTs?: number
): Promise<FeedTrade[]> {
  const trades = await fetchKalshiTrades(minTs);
  return trades.filter((trade) =>
    meetsProductFeedStakeThreshold(trade.usdNotional)
  );
}
