import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import { enrichTradesWithWhaleAlias } from "@/lib/trades/getTrades";
import { resolvePolymarketTradeDetail } from "@/lib/trades/resolveTradeByHash";

export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, max-age=60, stale-while-revalidate=120";

export async function GET(
  _request: Request,
  context: { params: { hash: string } }
) {
  const hash = decodeURIComponent(context.params.hash ?? "").trim();
  if (!hash) {
    return NextResponse.json({ error: "Missing trade hash" }, { status: 400 });
  }

  try {
    const { trade, relatedTrades } = await resolvePolymarketTradeDetail(hash);

    if (!trade) {
      return NextResponse.json(
        { trade: null },
        { status: 404, headers: { "Cache-Control": CACHE_CONTROL } }
      );
    }

    const enriched = await enrichTradesWithWhaleAlias(
      [trade, ...relatedTrades].map((row) => ({
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
          "Cache-Control": CACHE_CONTROL,
        },
      }
    );
  } catch (err) {
    console.error("[api/trades/[hash]]", err);
    return NextResponse.json(
      {
        trade: null,
        error: publicApiErrorMessage(err, "Failed to load trade"),
      },
      { status: 500 }
    );
  }
}
