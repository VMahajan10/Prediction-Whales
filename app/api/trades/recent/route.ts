import { NextRequest, NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import { parseRecentFeedCategoryFilter } from "@/lib/constants/categories";
import {
  fetchRecentFeedTrades,
  RECENT_TRADES_LIMIT,
} from "@/lib/feed/recentTradesServer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=5, stale-while-revalidate=10",
};

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

export async function GET(request: NextRequest) {
  try {
    const category = parseRecentFeedCategoryFilter(
      request.nextUrl.searchParams.get("category")
    );
    const { trades, degraded } = await fetchRecentFeedTrades({ category });
    const isEmptyOrDegraded = trades.length === 0 || degraded.length > 0;
    const headers = isEmptyOrDegraded ? NO_STORE_HEADERS : CACHE_HEADERS;

    return NextResponse.json(
      {
        trades,
        category,
        count: trades.length,
        target: RECENT_TRADES_LIMIT,
        degraded,
      },
      { headers }
    );
  } catch (error) {
    const message = publicApiErrorMessage(error, "Failed to fetch recent trades");
    console.error("[api/trades/recent]", error);
    return NextResponse.json(
      {
        trades: [],
        count: 0,
        target: RECENT_TRADES_LIMIT,
        degraded: ["polymarket", "kalshi"],
        error: message,
      },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
