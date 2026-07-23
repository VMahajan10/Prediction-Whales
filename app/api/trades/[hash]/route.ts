import { NextResponse } from "next/server";
import { fetchTrades } from "@/lib/polymarket";
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

    return NextResponse.json(
      {
        trade: {
          ...trade,
          proxyWallet: trade.proxyWallet ?? undefined,
        },
        relatedTrades: findRelatedTrades(trades, trade).map((t) => ({
          ...t,
          proxyWallet: t.proxyWallet ?? undefined,
        })),
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
