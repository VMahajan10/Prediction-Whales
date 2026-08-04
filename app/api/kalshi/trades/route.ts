import { fetchKalshiTrades } from "@/lib/kalshiTrades";
import { meetsProductFeedStakeThreshold } from "@/lib/feedQualification";
import { recordKalshiFeedMetrics } from "@/lib/feedQualificationServer";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

let cache: {
  minTs: number | undefined;
  data: { trades: Awaited<ReturnType<typeof fetchKalshiTrades>> };
  timestamp: number;
} | null = null;

const SERVER_CACHE_MS = 1500;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const minTsParam = searchParams.get("min_ts");
  const minTs =
    minTsParam != null && minTsParam !== ""
      ? parseInt(minTsParam, 10)
      : undefined;

  const now = Date.now();
  if (
    cache &&
    now - cache.timestamp < SERVER_CACHE_MS &&
    cache.minTs === minTs
  ) {
    return NextResponse.json(cache.data);
  }

  try {
    const trades = await fetchKalshiTrades(
      Number.isFinite(minTs) ? minTs : undefined
    );

    const detected = trades.filter((trade) =>
      meetsProductFeedStakeThreshold(trade.usdNotional)
    );
    recordKalshiFeedMetrics(detected.length);

    /**
     * Anonymous market flow — no wallet attribution, so these are gated on
     * stake + trade EV only and rendered without trader identity. Never
     * persisted: Kalshi Developer Agreement §3.1 prohibits storing raw API
     * data, so the client relies on this live poll plus in-memory retention.
     */
    const data = { trades: detected, ok: true as const };
    cache = { minTs, data, timestamp: now };
    return NextResponse.json(data);
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
