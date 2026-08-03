import { NextResponse } from "next/server";
import {
  collectPolymarketFeedCandidates,
  enrichPolymarketFeedTradesWithIdentity,
  filterTranslatablePolymarketFeedTrades,
} from "@/lib/feedQualificationServer";
import { fetchWhaleBackfill } from "@/lib/polymarket";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Credibility-qualified product feed — Polymarket whales only (feed v1 / OQ-2). */
export async function GET() {
  try {
    const trades = await fetchWhaleBackfill();
    const candidates = await collectPolymarketFeedCandidates(trades);
    const translatable = filterTranslatablePolymarketFeedTrades(candidates);
    const enriched = await enrichPolymarketFeedTradesWithIdentity(translatable);
    return NextResponse.json({ trades: enriched });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch product feed";
    console.error("[api/feed]", message);
    return NextResponse.json({ trades: [], error: message }, { status: 500 });
  }
}
