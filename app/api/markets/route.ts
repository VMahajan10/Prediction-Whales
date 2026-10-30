import { NextResponse } from "next/server";
import { publicApiErrorMessage } from "@/lib/apiError";
import { fetchMarkets } from "@/lib/polymarket";
import { getCachedMarketBySlug } from "@/lib/trades/marketBySlugCache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug");

  try {
    if (slug) {
      const market = await getCachedMarketBySlug(slug);
      return NextResponse.json(
        { markets: market ? [market] : [] },
        {
          headers: {
            "Cache-Control": "private, max-age=60, stale-while-revalidate=120",
          },
        }
      );
    }

    const markets = await fetchMarkets();
    return NextResponse.json({ markets });
  } catch (error) {
    const message = publicApiErrorMessage(error, "Failed to fetch markets");
    console.error("[api/markets]", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
