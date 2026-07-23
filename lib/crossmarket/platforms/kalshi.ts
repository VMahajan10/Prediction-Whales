import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import {
  fetchKalshiOpenMarkets,
  kalshiMarketUrl,
  kalshiYesMid,
  type KalshiMarket,
} from "@/lib/kalshi";
import { formatKalshiMarketDisplayTitle } from "@/lib/kalshiTitleResolver";
import type { RawMarket } from "./types";

const PLATFORM_FETCH_TIMEOUT_MS = 8000;

function kalshiVolume(m: KalshiMarket): number | null {
  const v = m.volume_fp != null ? parseFloat(String(m.volume_fp)) : NaN;
  return Number.isFinite(v) ? v : null;
}

function toRawMarket(m: KalshiMarket): RawMarket | null {
  const ticker = m.ticker;
  if (!ticker) return null;

  const title =
    formatKalshiMarketDisplayTitle({
      ticker,
      title: typeof m.title === "string" ? m.title : null,
      yes_sub_title:
        typeof m.yes_sub_title === "string" ? m.yes_sub_title : null,
      no_sub_title:
        typeof m.no_sub_title === "string" ? m.no_sub_title : null,
      market_type:
        typeof m.market_type === "string" ? m.market_type : null,
      mve_selected_legs: Array.isArray(m.mve_selected_legs)
        ? m.mve_selected_legs
        : null,
    }) ?? ticker;

  return {
    platform: "kalshi",
    external_id: ticker,
    tier: 1,
    title,
    raw_payload: m as Record<string, unknown>,
    yes_price: kalshiYesMid(m),
    volume: kalshiVolume(m),
    url: kalshiMarketUrl(ticker, title),
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
