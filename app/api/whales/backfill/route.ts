import { NextResponse } from "next/server";
import { filterQualifiedPolymarketFeedTrades } from "@/lib/feedQualificationServer";
import { fetchWhaleBackfill } from "@/lib/polymarket";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const trades = await fetchWhaleBackfill();
    const qualified = await filterQualifiedPolymarketFeedTrades(trades);
    return NextResponse.json({ trades: qualified });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch whale backfill";
    console.error("[api/whales/backfill]", message);
    return NextResponse.json({ trades: [], error: message }, { status: 500 });
  }
}
