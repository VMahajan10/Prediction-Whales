import { NextResponse } from "next/server";
import { fetchRecentFeedTrades } from "@/lib/feed/recentTradesServer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=5, stale-while-revalidate=10",
};

export async function GET() {
  try {
    const trades = await fetchRecentFeedTrades();
    return NextResponse.json({ trades }, { headers: CACHE_HEADERS });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch recent trades";
    console.error("[api/trades/recent]", message);
    return NextResponse.json(
      { trades: [], error: message },
      { status: 500, headers: CACHE_HEADERS }
    );
  }
}
