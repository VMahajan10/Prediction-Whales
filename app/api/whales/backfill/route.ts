import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import {
  enrichPolymarketFeedTradesWithIdentity,
  filterQualifiedPolymarketFeedTrades,
  filterTranslatablePolymarketFeedTrades,
} from "@/lib/feedQualificationServer";
import { fetchWhaleBackfill } from "@/lib/polymarket";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const trades = await fetchWhaleBackfill();
    const qualified = await filterQualifiedPolymarketFeedTrades(trades);
    const translatable = filterTranslatablePolymarketFeedTrades(qualified);
    const enriched = await enrichPolymarketFeedTradesWithIdentity(translatable);
    return NextResponse.json({ trades: enriched });
  } catch (error) {
    const message = publicApiErrorMessage(error, "Failed to fetch whale backfill");
    console.error("[api/whales/backfill]", error);
    return NextResponse.json({ trades: [], error: message }, { status: 500 });
  }
}
