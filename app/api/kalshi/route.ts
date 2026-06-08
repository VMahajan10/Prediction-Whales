import { NextResponse } from "next/server";
import { normalizePredictIt } from "@/lib/predictit";
import type { Market } from "@/lib/polymarket";

const PREDICTIT_API_URL = "https://www.predictit.org/api/marketdata/all/";
const CACHE_TTL = 300_000; // 5 minutes

interface CacheEntry {
  data: { markets: Market[] };
  timestamp: number;
}

let cache: CacheEntry | null = null;

const fetchWithRetry = async (
  url: string,
  options: RequestInit
): Promise<Response> => {
  try {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    return res;
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
    return fetch(url, options);
  }
};

export async function GET() {
  try {
    const now = Date.now();
    if (cache && now - cache.timestamp < CACHE_TTL) {
      return NextResponse.json(cache.data);
    }

    const res = await fetchWithRetry(PREDICTIT_API_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      next: { revalidate: 0 },
    });

    if (!res.ok) {
      throw new Error(`PredictIt returned ${res.status}`);
    }

    const contentType = res.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      throw new Error("PredictIt returned non-JSON response");
    }

    const data = await res.json();
    const markets = normalizePredictIt(data);
    const response = { markets };
    cache = { data: response, timestamp: now };
    return NextResponse.json(response);
  } catch (err) {
    if (cache) {
      return NextResponse.json({
        ...cache.data,
        cached: true,
        cacheAge: Math.round((Date.now() - cache.timestamp) / 1000),
      });
    }
    return NextResponse.json(
      { markets: [], error: String(err) },
      { status: 500 }
    );
  }
}
