import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import {
  fetchKalshiOpenMarkets,
  kalshiMarketUrl,
  kalshiYesMid,
  type KalshiMarket,
} from "@/lib/kalshi";
import type { RawMarket } from "./types";

const PLATFORM_FETCH_TIMEOUT_MS = 8000;

function kalshiVolume(m: KalshiMarket): number | null {
  const v = m.volume_fp != null ? parseFloat(String(m.volume_fp)) : NaN;
  return Number.isFinite(v) ? v : null;
}

function toRawMarket(m: KalshiMarket): RawMarket | null {
  const ticker = m.ticker;
  if (!ticker) return null;

  return {
    platform: "kalshi",
    external_id: ticker,
    tier: 1,
    title: (m.title as string | undefined) ?? ticker,
    raw_payload: m as Record<string, unknown>,
    yes_price: kalshiYesMid(m),
    volume: kalshiVolume(m),
    url: kalshiMarketUrl(ticker),
    yes_price_kind: "tradeable",
  };
}

/** Tier-1 Kalshi fetcher — wraps `lib/kalshi.ts` public REST pagination. */
export async function fetchKalshiRawMarkets(): Promise<RawMarket[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PLATFORM_FETCH_TIMEOUT_MS);

    const markets = await fetchKalshiOpenMarkets({
      maxPages: 10,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    return markets
      .map(toRawMarket)
      .filter((m): m is RawMarket => m != null);
  } catch (err) {
    console.error("[crossmarket/kalshi] fetch failed:", err);
    return [];
  }
}
