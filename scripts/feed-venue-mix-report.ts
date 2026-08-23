import "./preload-env";

import { fetchRecentFeedTrades } from "@/lib/feed/recentTradesServer";
import { isDatabaseEnabled } from "@/lib/crossmarket/store/db";

/** Exercises the real /api/trades/recent read path and reports the venue mix. */
async function main() {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  const { trades, degraded } = await fetchRecentFeedTrades({ category: "all" });

  const kalshi = trades.filter((t) => t.source === "kalshi");
  const polymarket = trades.filter((t) => t.source === "polymarket");
  const timestamps = trades.map((t) => t.timestamp);
  const sortedDesc =
    JSON.stringify(timestamps) ===
    JSON.stringify([...timestamps].sort((a, b) => b - a));

  console.log({
    total: trades.length,
    kalshi: kalshi.length,
    polymarket: polymarket.length,
    sortedNewestFirst: sortedDesc,
    degraded,
    minStake: Math.min(...trades.map((t) => t.usdNotional)),
    minEvPercent: Math.min(...trades.map((t) => t.netEvPercent ?? Infinity)),
  });

  console.log(
    "\noldest Kalshi rows now surfacing:",
    kalshi.slice(-3).map((t) => ({
      ticker: t.ticker,
      ev: t.netEvPercent,
      stake: Math.round(t.usdNotional),
      tradedAt: t.traded_at,
    }))
  );

  process.exit(0);
}

void main();
