import { NextResponse } from "next/server";
import {
  enrichPolymarketFeedTradesWithIdentity,
  filterQualifiedPolymarketFeedTrades,
  filterTranslatablePolymarketFeedTrades,
} from "@/lib/feedQualificationServer";
import { fetchWhaleBackfill } from "@/lib/polymarket";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Credibility-qualified product feed with registry-backed whale identities. */
export async function GET() {
  try {
    const trades = await fetchWhaleBackfill();
    const qualified = await filterQualifiedPolymarketFeedTrades(trades);
    const translatable = filterTranslatablePolymarketFeedTrades(qualified);
    const enriched = await enrichPolymarketFeedTradesWithIdentity(translatable);
    return NextResponse.json({ trades: enriched });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch product feed";
    console.error("[api/feed]", message);
    return NextResponse.json({ trades: [], error: message }, { status: 500 });
  }
}
