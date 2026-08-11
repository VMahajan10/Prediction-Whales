import { collectKalshiFeedCandidates } from "@/lib/feed/kalshiFeedCandidatesServer";
import { recordKalshiFeedMetrics } from "@/lib/feedQualificationServer";
import { KALSHI_TRADES_POLL_MS } from "@/lib/ingestionPollConfig";
import { flushKalshiShadowTradesNow } from "@/lib/x-agent/kalshiShadowTrades";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

let cache: {
  data: { trades: Awaited<ReturnType<typeof collectKalshiFeedCandidates>>; ok: true };
  timestamp: number;
} | null = null;

const SERVER_CACHE_MS = KALSHI_TRADES_POLL_MS;

function filterTradesByMinTs<T extends { timestamp: number }>(
  trades: T[],
  minTs?: number
): T[] {
  if (minTs == null || !Number.isFinite(minTs) || minTs <= 0) return trades;
  return trades.filter((trade) => trade.timestamp > minTs);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const minTsParam = searchParams.get("min_ts");
  const minTs =
    minTsParam != null && minTsParam !== ""
      ? parseInt(minTsParam, 10)
      : undefined;

  const now = Date.now();
  if (cache && now - cache.timestamp < SERVER_CACHE_MS) {
    const trades = filterTradesByMinTs(cache.data.trades, minTs);
    return NextResponse.json({ trades, ok: true as const });
  }

  try {
    const detected = await collectKalshiFeedCandidates();
    recordKalshiFeedMetrics(detected.length);

    // Queued during fetchKalshiTrades — must land before serverless freeze.
    await flushKalshiShadowTradesNow();

    /**
     * Anonymous market flow — no wallet attribution, so these are gated on
     * stake + trade EV only and rendered without trader identity. Never
     * persisted: Kalshi Developer Agreement §3.1 prohibits storing raw API
     * data, so the client relies on this live poll plus in-memory retention.
     */
    const data = { trades: detected, ok: true as const };
    cache = { data, timestamp: now };
    const trades = filterTradesByMinTs(detected, minTs);
    return NextResponse.json({ trades, ok: true as const });
  } catch (err) {
    console.error("[api/kalshi/trades]", err);
    return NextResponse.json(
      {
        trades: [],
        ok: false as const,
        error: err instanceof Error ? err.message : "Failed to fetch Kalshi trades",
      },
      { status: 502 }
    );
  }
}
