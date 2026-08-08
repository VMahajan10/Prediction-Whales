import { NextRequest, NextResponse } from "next/server";
import {
  fetchRecentFeedTrades,
  parseRecentFeedCategoryFilter,
} from "@/lib/feed/recentTradesServer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=5, stale-while-revalidate=10",
};

export async function GET(request: NextRequest) {
  try {
    const category = parseRecentFeedCategoryFilter(
      request.nextUrl.searchParams.get("category")
    );
    const trades = await fetchRecentFeedTrades({ category });
    return NextResponse.json({ trades, category }, { headers: CACHE_HEADERS });
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
