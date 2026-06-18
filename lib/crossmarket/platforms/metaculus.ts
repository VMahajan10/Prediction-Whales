import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
import type { RawMarket } from "./types";

const METACULUS_API = "https://www.metaculus.com/api2/questions/";
const PLATFORM_FETCH_TIMEOUT_MS = 8000;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;

interface MetaculusCommunityPrediction {
  full?: {
    q2?: number | null;
    mean?: number | null;
  };
}

interface MetaculusQuestion {
  id: number;
  title: string;
  url?: string;
  type?: string;
  status?: string;
  number_of_predictions?: number;
  forecasts_count?: number;
  community_prediction?: MetaculusCommunityPrediction;
  possibilities?: { type?: string };
  [key: string]: unknown;
}

interface MetaculusListResponse {
  results?: MetaculusQuestion[];
  next?: string | null;
}

function metaculusToken(): string | null {
  return process.env.METACULUS_API_TOKEN?.trim() || null;
}

/**
 * Community median (q2) for binary forecast questions — NOT a tradeable price.
 * Returns null when absent or non-finite.
 */
export function metaculusForecastConsensus(q: MetaculusQuestion): number | null {
  const qType = q.possibilities?.type ?? q.type;
  if (qType && qType !== "binary") return null;

  const q2 = q.community_prediction?.full?.q2;
  if (typeof q2 !== "number" || !Number.isFinite(q2)) return null;
  if (q2 < 0 || q2 > 1) return null;
  return q2;
}

function metaculusPredictionCount(q: MetaculusQuestion): number | null {
  const n = q.number_of_predictions ?? q.forecasts_count;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return n;
}

function metaculusUrl(q: MetaculusQuestion): string | null {
  if (q.url) return q.url;
  return `https://www.metaculus.com/questions/${q.id}/`;
}

function toRawMarket(q: MetaculusQuestion): RawMarket | null {
  if (!q.id || !q.title) return null;
  if (q.status && q.status !== "open") return null;

  return {
    platform: "metaculus",
    external_id: String(q.id),
    tier: 1,
    title: q.title,
    raw_payload: q as Record<string, unknown>,
    yes_price: metaculusForecastConsensus(q),
    volume: metaculusPredictionCount(q),
    url: metaculusUrl(q),
    yes_price_kind: "forecast_consensus",
  };
}

/**
 * Tier-1 Metaculus fetcher — requires `METACULUS_API_TOKEN` (API is auth-only).
 * `yes_price` = community median forecast (q2), not a tradeable market quote.
 */
export async function fetchMetaculusRawMarkets(): Promise<RawMarket[]> {
  const token = metaculusToken();
  if (!token) {
    console.warn(
      "[crossmarket/metaculus] METACULUS_API_TOKEN not set — skipping fetch"
    );
    return [];
  }

  const out: RawMarket[] = [];
  let offset = 0;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        limit: String(PAGE_LIMIT),
        offset: String(offset),
        status: "open",
        type: "forecast",
        order_by: "-activity",
      });

      const res = await fetchWithTimeout(`${METACULUS_API}?${params}`, {
        headers: {
          Accept: "application/json",
          Authorization: `Token ${token}`,
        },
        timeoutMs: PLATFORM_FETCH_TIMEOUT_MS,
      });

      if (!res.ok) {
        console.error(
          `[crossmarket/metaculus] HTTP ${res.status} on page ${page}`
        );
        break;
      }

      const data = (await res.json()) as MetaculusListResponse;
      const results = data.results ?? [];
      if (results.length === 0) break;

      for (const q of results) {
        const row = toRawMarket(q);
        if (row) out.push(row);
      }

      offset += results.length;
      if (!data.next && results.length < PAGE_LIMIT) break;
    }
  } catch (err) {
    console.error("[crossmarket/metaculus] fetch failed:", err);
  }

  return out;
}
