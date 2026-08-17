import "server-only";

import {
  meetsProductFeedEvThreshold,
  meetsProductFeedStakeThreshold,
} from "@/lib/feedQualification";
import { fetchKalshiTrades } from "@/lib/kalshiTradesServer";
import type { FeedTrade } from "@/lib/feedTradeTypes";

/**
 * Transient Kalshi product-feed candidates — stake + trade EV qualified only.
 * No wallet checks (Kalshi exposes no trader identity). Raw API rows are not
 * persisted beyond shadow logging for qualifying trades.
 */
export async function collectKalshiFeedCandidates(
  minTs?: number
): Promise<FeedTrade[]> {
  const trades = await fetchKalshiTrades(minTs);
  const stakeQualified = trades.filter((trade) =>
    meetsProductFeedStakeThreshold(trade.usdNotional)
  );
  const evQualified = stakeQualified.filter((trade) =>
    meetsProductFeedEvThreshold(trade.netEvPercent)
  );
  console.log(
    `[kalshi/feed] candidates evQualified=${evQualified.length} stakeQualified=${stakeQualified.length} total=${trades.length}`
  );
  return evQualified;
}
