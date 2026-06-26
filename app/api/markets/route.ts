import { NextResponse } from "next/server";
import { fetchMarketBySlug, fetchMarkets } from "@/lib/polymarket";

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug");

  try {
    if (slug) {
      const market = await fetchMarketBySlug(slug);
      return NextResponse.json({ markets: market ? [market] : [] });
    }

    const markets = await fetchMarkets();
    return NextResponse.json({ markets });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch markets";
    console.error("[api/markets]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
