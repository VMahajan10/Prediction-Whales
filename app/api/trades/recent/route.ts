import { NextRequest, NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import { parseRecentFeedCategoryFilter } from "@/lib/constants/categories";
import {
  fetchRecentFeedTrades,
  RECENT_TRADES_LIMIT,
} from "@/lib/feed/recentTradesServer";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=5, stale-while-revalidate=10",
};

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

function emptyRecentTradesResponse(
  category: ReturnType<typeof parseRecentFeedCategoryFilter>,
  degraded: string[] = ["polymarket", "kalshi"],
  error?: string
) {
  return NextResponse.json(
    {
      trades: [],
      category,
      count: 0,
      target: RECENT_TRADES_LIMIT,
      degraded,
      ...(error ? { error } : {}),
    },
    { status: 200, headers: NO_STORE_HEADERS }
  );
}

export async function GET(request: NextRequest) {
  const category = parseRecentFeedCategoryFilter(
    request.nextUrl.searchParams.get("category")
  );

  logger.debugForPath(
    "/api/trades/recent",
    "[api/trades/recent] Fetching recent trades..."
  );

  try {
    const { trades, degraded } = await fetchRecentFeedTrades({ category });
    const isEmptyOrDegraded = trades.length === 0 || degraded.length > 0;
    const headers = isEmptyOrDegraded ? NO_STORE_HEADERS : CACHE_HEADERS;

    logger.debugForPath(
      "/api/trades/recent",
      `[api/trades/recent] Successfully returned ${trades.length} trades`
    );

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
    console.error("[api/trades/recent Error]", error);
    return emptyRecentTradesResponse(category, ["polymarket", "kalshi"], message);
  }
}
