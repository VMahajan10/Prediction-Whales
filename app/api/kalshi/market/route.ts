import {
  fetchKalshiMarketDetail,
  isKalshiMarketTicker,
  kalshiMarketDetailToSummary,
} from "@/lib/kalshiDetail";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const ticker = request.nextUrl.searchParams.get("ticker")?.trim();

  if (!ticker) {
    return NextResponse.json({ error: "ticker required" }, { status: 400 });
  }

  if (!isKalshiMarketTicker(ticker)) {
    return NextResponse.json({ error: "Invalid Kalshi ticker" }, { status: 400 });
  }

  try {
    const detail = await fetchKalshiMarketDetail(ticker);
    if (!detail) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    return NextResponse.json({ market: kalshiMarketDetailToSummary(detail) });
  } catch (err) {
    console.error("[api/kalshi/market]", err);
    return NextResponse.json(
      { error: "Failed to load Kalshi market" },
      { status: 502 }
    );
  }
}
