import "server-only";

import { meetsProductFeedStakeThreshold } from "@/lib/feedQualification";
import { fetchKalshiTrades } from "@/lib/kalshiTradesServer";
import type { FeedTrade } from "@/lib/feedTradeTypes";

/**
 * Transient Kalshi product-feed candidates — stake-qualified only, no EV gate.
 * Raw Kalshi API data is not persisted (Kalshi Developer Agreement §3.1).
 */
export async function collectKalshiFeedCandidates(
  minTs?: number
): Promise<FeedTrade[]> {
  const trades = await fetchKalshiTrades(minTs);
  const stakeQualified = trades.filter((trade) =>
    meetsProductFeedStakeThreshold(trade.usdNotional)
  );
  console.log(
    `[kalshi/feed] candidates stakeQualified=${stakeQualified.length} total=${trades.length}`
  );
  return stakeQualified;
}
