import { NextResponse } from "next/server";
import { fetchTrades } from "@/lib/polymarket";
import { enrichTradesWithWhaleAlias } from "@/lib/trades/getTrades";
import { findRelatedTrades, findTradeByHash } from "@/lib/whaleProfile";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  context: { params: { hash: string } }
) {
  const hash = decodeURIComponent(context.params.hash ?? "").trim();
  if (!hash) {
    return NextResponse.json({ error: "Missing trade hash" }, { status: 400 });
  }

  try {
    const trades = await fetchTrades();
    const trade = findTradeByHash(trades, hash);

    if (!trade) {
      return NextResponse.json({ trade: null }, { status: 404 });
    }

    const related = findRelatedTrades(trades, trade);
    const enriched = await enrichTradesWithWhaleAlias(
      [trade, ...related].map((row) => ({
        ...row,
        source: "polymarket" as const,
        proxyWallet: row.proxyWallet ?? undefined,
      }))
    );
    const [enrichedTrade, ...enrichedRelated] = enriched;

    return NextResponse.json(
      {
        trade: enrichedTrade,
        relatedTrades: enrichedRelated,
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        },
      }
    );
  } catch (err) {
    return NextResponse.json(
      { trade: null, error: String(err) },
      { status: 500 }
    );
  }
}
