import { NextResponse } from "next/server";
import { fetchTrades } from "@/lib/polymarket";
import { filterQualifiedPolymarketFeedTrades } from "@/lib/feedQualificationServer";
import { enrichTradesWithWhaleAlias } from "@/lib/trades/getTrades";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const trades = (await fetchTrades())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20);

    const qualified = await filterQualifiedPolymarketFeedTrades(trades);

    const enriched = await enrichTradesWithWhaleAlias(
      qualified.map((trade) => ({
        ...trade,
        source: "polymarket" as const,
        proxyWallet: trade.proxyWallet ?? undefined,
      }))
    );

    return NextResponse.json(
      { trades: enriched },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      }
    );
  } catch (err) {
    console.error("[api/trades]", err);
    return NextResponse.json(
      { trades: [], error: String(err) },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      }
    );
  }
}
