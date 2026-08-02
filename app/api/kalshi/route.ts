import { KalshiClient } from "@kalshi/sdk";
import { cacheKalshiTitlesFromMarkets } from "@/lib/kalshiTitleResolver";
import { recordPrices } from "@/lib/kalshiPriceStore";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

let cache: { data: { markets: unknown[] }; timestamp: number } | null = null;
const CACHE_TTL = 10000; // 10 seconds

function asSafeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

const cleanTitle = (title: string | null | undefined): string => {
  const normalized = asSafeString(title);
  if (!normalized) return "Unknown market";
  return normalized
    .replace("Pro Basketball Finals", "NBA Finals")
    .replace("Pro Baseball Championship", "MLB World Series")
    .replace("Pro Football Championship", "NFL Super Bowl")
    .replace("Pro Hockey Championship", "NHL Stanley Cup")
    .replace("Pro Basketball", "NBA")
    .replace("Pro Baseball", "MLB");
};

function marketTagsInclude(value: unknown, needle: string): boolean {
  if (typeof value === "string") {
    return value.toLowerCase().includes(needle);
  }
  if (!Array.isArray(value)) return false;
  return value.some((tag) => marketTagsInclude(tag, needle));
}

function marketFieldIncludes(
  value: unknown,
  needle: string,
  options?: { ignoreCase?: boolean }
): boolean {
  if (typeof value !== "string") return false;
  const haystack = options?.ignoreCase ? value.toLowerCase() : value;
  const n = options?.ignoreCase ? needle.toLowerCase() : needle;
  return haystack.includes(n);
}

export async function GET() {
  try {
    const now = Date.now();
    if (cache && now - cache.timestamp < CACHE_TTL) {
      await recordPrices(cache.data.markets as { id: string; probability: number }[]);
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
        if (Array.isArray(seriesMarkets) && seriesMarkets.length > 0) {
          allMarkets.push(...seriesMarkets);
        }
      } catch {
        // Skip failed series silently
      }
    }

    const markets = allMarkets;

    const filtered = (markets ?? []).filter((m: any) => {
      const tags = m?.tags;
      const noLegs = !m?.mve_selected_legs?.length;
      const notParlay = !marketFieldIncludes(m?.title, ",yes ");
      const notMultivariate = !marketFieldIncludes(m?.ticker, "KXMVE");
      const notMultivariateCategory = !marketFieldIncludes(
        m?.category,
        "multivariate",
        { ignoreCase: true }
      );
      const notMultivariateTag = !marketTagsInclude(tags, "multivariate");
      const hasVolume = parseFloat(m?.volume_fp ?? "0") >= 100;
      return (
        noLegs &&
        notParlay &&
        notMultivariate &&
        notMultivariateCategory &&
        notMultivariateTag &&
        hasVolume
      );
    });

    // Deduplicate by question — keep highest volume per question
    const seen = new Map<string, any>();
    filtered.forEach((m: any) => {
      const key =
        asSafeString(m?.title).slice(0, 40) || asSafeString(m?.ticker) || "unknown";
      const existing = seen.get(key);
      if (
        !existing ||
        parseFloat(m?.volume_fp ?? "0") > parseFloat(existing?.volume_fp ?? "0")
      ) {
        seen.set(key, m);
      }
    });

    const simple = Array.from(seen.values())
      .sort(
        (a, b) =>
          parseFloat(b?.volume_fp ?? "0") - parseFloat(a?.volume_fp ?? "0")
      )
      .slice(0, 20)
      .map((m: any) => ({
        id: asSafeString(m?.ticker, "unknown"),
        conditionId: asSafeString(m?.ticker, "unknown"),
        clobTokenIds: [] as string[],
        question: cleanTitle(m?.title ?? m?.ticker),
        probability: parseFloat(m?.yes_bid_dollars ?? "0"),
        volume: parseFloat(m?.volume_fp ?? "0"),
        spread:
          Math.round(
            (parseFloat(m?.yes_ask_dollars ?? "0") -
              parseFloat(m?.yes_bid_dollars ?? "0")) *
              100 *
              10
          ) / 10,
        active: m?.status === "active",
        source: "kalshi" as const,
        rawContracts: [],
      }));

    await recordPrices(simple);
    await cacheKalshiTitlesFromMarkets(simple);

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
