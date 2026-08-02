import { KalshiClient } from "@kalshi/sdk";
import { cacheKalshiTitlesFromMarkets } from "@/lib/kalshiTitleResolver";
import { recordPrices } from "@/lib/kalshiPriceStore";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

let cache: { data: { markets: unknown[] }; timestamp: number } | null = null;
const CACHE_TTL = 10000; // 10 seconds

function asSafeString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
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
  if (value == null) return false;
  if (typeof value === "string") {
    return (value || "").toLowerCase().includes(needle);
  }
  if (!Array.isArray(value)) return false;
  return value.some(
    (tag) => tag != null && marketTagsInclude(tag, needle)
  );
}

function isSafeMarketCandidate(m: unknown): m is Record<string, unknown> {
  return m != null && typeof m === "object";
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
        const listResult = await client.markets.list({
          limit: 10,
          status: "open",
          series_ticker: series,
        });
        const seriesMarkets = listResult?.markets;
        if (Array.isArray(seriesMarkets) && seriesMarkets.length > 0) {
          allMarkets.push(...seriesMarkets);
        }
      } catch {
        // Skip failed series silently
      }
    }

    const markets = allMarkets;

    const filtered = (markets ?? []).filter((m: unknown) => {
      if (!isSafeMarketCandidate(m)) return false;

      try {
        const tags = m.tags;
        const legs = m.mve_selected_legs;
        const noLegs = !Array.isArray(legs) || legs.length === 0;
        const notParlay = !asSafeString(m.title).includes(",yes ");
        const notMultivariate = !asSafeString(m.ticker).includes("KXMVE");
        const notMultivariateCategory = !asSafeString(m.category)
          .toLowerCase()
          .includes("multivariate");
        const notMultivariateTag = !marketTagsInclude(tags, "multivariate");
        const hasVolume = parseFloat(asSafeString(m.volume_fp, "0")) >= 100;
        return (
          noLegs &&
          notParlay &&
          notMultivariate &&
          notMultivariateCategory &&
          notMultivariateTag &&
          hasVolume
        );
      } catch {
        return false;
      }
    });

    // Deduplicate by question — keep highest volume per question
    const seen = new Map<string, any>();
    filtered.forEach((m: unknown) => {
      if (!isSafeMarketCandidate(m)) return;

      const key =
        asSafeString(m.title).slice(0, 40) ||
        asSafeString(m.ticker) ||
        "unknown";
      const existing = seen.get(key);
      const volume = parseFloat(asSafeString(m.volume_fp, "0"));
      const existingVolume = parseFloat(
        asSafeString(
          existing && typeof existing === "object"
            ? (existing as Record<string, unknown>).volume_fp
            : undefined,
          "0"
        )
      );
      if (!existing || volume > existingVolume) {
        seen.set(key, m);
      }
    });

    const simple = Array.from(seen.values())
      .filter(isSafeMarketCandidate)
      .sort(
        (a, b) =>
          parseFloat(asSafeString(b.volume_fp, "0")) -
          parseFloat(asSafeString(a.volume_fp, "0"))
      )
      .slice(0, 20)
      .map((m) => ({
        id: asSafeString(m.ticker, "unknown"),
        conditionId: asSafeString(m.ticker, "unknown"),
        clobTokenIds: [] as string[],
        question: cleanTitle(
          asSafeString(m.title) || asSafeString(m.ticker) || undefined
        ),
        probability: parseFloat(asSafeString(m.yes_bid_dollars, "0")),
        volume: parseFloat(asSafeString(m.volume_fp, "0")),
        spread:
          Math.round(
            (parseFloat(asSafeString(m.yes_ask_dollars, "0")) -
              parseFloat(asSafeString(m.yes_bid_dollars, "0"))) *
              100 *
              10
          ) / 10,
        active: m.status === "active",
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
