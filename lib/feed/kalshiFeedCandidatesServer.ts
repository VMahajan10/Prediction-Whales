import "server-only";

import {
  meetsProductFeedEvThreshold,
  meetsProductFeedStakeThreshold,
} from "@/lib/feedQualification";
import { fetchKalshiTrades } from "@/lib/kalshiTradesServer";
import type { FeedTrade } from "@/lib/feedTradeTypes";
import { flushKalshiShadowTradesNow } from "@/lib/x-agent/kalshiShadowTrades";
import {
  logKalshiEvGateDrop,
  logKalshiGatePass,
} from "@/lib/feed/kalshiIngestTrace";

/**
 * Transient Kalshi product-feed candidates — stake + trade EV qualified only.
 * No wallet checks (Kalshi exposes no trader identity). Qualifying rows are
 * shadow-logged during {@link fetchKalshiTrades} for /api/trades/recent hydration.
 */
export async function collectKalshiFeedCandidates(
  minTs?: number
): Promise<FeedTrade[]> {
  const trades = await fetchKalshiTrades(minTs);
  void flushKalshiShadowTradesNow();

  const stakeQualified = trades.filter((trade) =>
    meetsProductFeedStakeThreshold(trade.usdNotional)
  );
  const evQualified = stakeQualified.filter((trade) =>
    meetsProductFeedEvThreshold(trade.netEvPercent)
  );
  for (const trade of evQualified) {
    logKalshiGatePass(trade, trade.netEvPercent!);
  }
  for (const trade of stakeQualified) {
    if (!meetsProductFeedEvThreshold(trade.netEvPercent)) {
      logKalshiEvGateDrop(trade, trade.netEvPercent ?? null);
    }
  }
  console.log(
    `[kalshi/feed] candidates evQualified=${evQualified.length} stakeQualified=${stakeQualified.length} total=${trades.length} shadowFlush=ok`
  );
  return evQualified;
}
