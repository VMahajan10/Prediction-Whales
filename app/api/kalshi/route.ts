import { KalshiClient } from "@kalshi/sdk";
import { NextResponse } from "next/server";

let cache: { data: { markets: unknown[] }; timestamp: number } | null = null;
const CACHE_TTL = 60000; // 1 minute

const cleanTitle = (title: string): string => {
  if (!title) return title;
  return title
    .replace("Pro Basketball Finals", "NBA Finals")
    .replace("Pro Baseball Championship", "MLB World Series")
    .replace("Pro Football Championship", "NFL Super Bowl")
    .replace("Pro Hockey Championship", "NHL Stanley Cup")
    .replace("Pro Basketball", "NBA")
    .replace("Pro Baseball", "MLB");
};

export async function GET() {
  try {
    const now = Date.now();
    if (cache && now - cache.timestamp < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }

    const client = new KalshiClient({
      keyId: process.env.KALSHI_KEY_ID!,
      privateKey: process.env.KALSHI_PRIVATE_KEY!,
    });

    // Fetch from specific series known to have simple
    // binary markets with real price data
    const seriesTickers = [
      "KXELONMARS",
      "KXNEWPOPE",
      "KXWARMING",
      "KXBTC",
      "KXETH",
      "KXFED",
      "KXNFL",
      "KXNBA",
      "KXMLB",
    ];

    const allMarkets: any[] = [];

    for (const series of seriesTickers) {
      try {
        const { markets: seriesMarkets } = await client.markets.list({
          limit: 10,
          status: "open",
          series_ticker: series,
        });
        if (seriesMarkets) allMarkets.push(...seriesMarkets);
      } catch {
        // Skip failed series silently
      }
    }

    const markets = allMarkets;

    const filtered = (markets ?? []).filter((m: any) => {
      const noLegs = !m.mve_selected_legs?.length;
      const notParlay = !m.title?.includes(",yes ");
      const notMultivariate = !m.ticker?.includes("KXMVE");
      const hasVolume = parseFloat(m.volume_fp ?? "0") >= 100;
      return noLegs && notParlay && notMultivariate && hasVolume;
    });

    // Deduplicate by question — keep highest volume per question
    const seen = new Map<string, any>();
    filtered.forEach((m: any) => {
      const key = m.title?.slice(0, 40) ?? m.ticker;
      const existing = seen.get(key);
      if (
        !existing ||
        parseFloat(m.volume_fp) > parseFloat(existing.volume_fp)
      ) {
        seen.set(key, m);
      }
    });

    const simple = Array.from(seen.values())
      .sort(
        (a, b) => parseFloat(b.volume_fp) - parseFloat(a.volume_fp)
      )
      .slice(0, 20)
      .map((m: any) => ({
        id: m.ticker,
        conditionId: m.ticker,
        clobTokenIds: [] as string[],
        question: cleanTitle(m.title ?? m.ticker),
        probability: parseFloat(m.yes_bid_dollars ?? "0"),
        volume: parseFloat(m.volume_fp ?? "0"),
        spread:
          Math.round(
            (parseFloat(m.yes_ask_dollars ?? "0") -
              parseFloat(m.yes_bid_dollars ?? "0")) *
              100 *
              10
          ) / 10,
        active: m.status === "active",
        source: "kalshi" as const,
        rawContracts: [],
      }));

    const response = { markets: simple };
    cache = { data: response, timestamp: now };
    return NextResponse.json(response);
  } catch (err) {
    console.error("Kalshi API error:", err);
    return NextResponse.json(
      { markets: [], error: String(err) },
      { status: 500 }
    );
  }
}
