import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import { fetchMarketBySlug, fetchMarkets } from "@/lib/polymarket";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
    const message = publicApiErrorMessage(error, "Failed to fetch markets");
    console.error("[api/markets]", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
