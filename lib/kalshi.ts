import { buildKalshiMarketUrl } from "@/lib/platformTradeUrls";

const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

const DEFAULT_PAGE_LIMIT = 200;
const DEFAULT_MAX_PAGES = 25;

/** Kalshi market object from the public REST API (subset used by MarketPulse). */
export interface KalshiMarket {
  ticker?: string;
  title?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  volume_24h_fp?: string;
  updated_time?: string;
  expected_expiration_time?: string;
  status?: string;
  result?: string;
  event_ticker?: string;
  [key: string]: unknown;
}

interface KalshiMarketsPage {
  markets?: KalshiMarket[];
  cursor?: string | null;
}

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Midpoint of yes bid/ask — null when either side missing or non-positive. */
export function kalshiYesMid(m: KalshiMarket): number | null {
  const bid = parseNum(m.yes_bid_dollars);
  const ask = parseNum(m.yes_ask_dollars);
  if (bid == null || ask == null || bid <= 0 || ask <= 0) return null;
  return (bid + ask) / 2;
}

export function kalshiMarketUrl(ticker: string, title?: string): string {
  return buildKalshiMarketUrl({ marketTicker: ticker, title });
}

async function fetchKalshiMarketsPage(
  params: URLSearchParams,
  signal?: AbortSignal
): Promise<KalshiMarketsPage> {
  const res = await fetch(`${KALSHI_API}/markets?${params}`, {
    headers: { Accept: "application/json", "User-Agent": "MarketPulse/1.0" },
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw new Error(`Kalshi markets HTTP ${res.status}`);
  }
  return res.json() as Promise<KalshiMarketsPage>;
}

export interface FetchKalshiOpenMarketsOptions {
  /** When set, only fetch markets for this series ticker. */
  seriesTicker?: string;
  limit?: number;
  maxPages?: number;
  signal?: AbortSignal;
}

/**
 * Paginated fetch of open Kalshi markets via the public REST API.
 * Used by cross-market ingestion and the sports EV path (`crossMarketEv.ts`).
 */
export async function fetchKalshiOpenMarkets(
  options: FetchKalshiOpenMarketsOptions = {}
): Promise<KalshiMarket[]> {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const all: KalshiMarket[] = [];
  let cursor: string | null | undefined = undefined;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      status: "open",
      limit: String(limit),
    });
    if (options.seriesTicker) {
      params.set("series_ticker", options.seriesTicker);
    }
    if (cursor) params.set("cursor", cursor);

    const data = await fetchKalshiMarketsPage(params, options.signal);
    if (data.markets?.length) all.push(...data.markets);

    cursor = data.cursor;
    if (!cursor) break;
  }

  return all;
}

/** @deprecated Use fetchKalshiOpenMarkets — sports EV path for configured game series. */
export async function fetchKalshiGameMarkets(
  series: readonly string[] = ["KXWCGAME"]
): Promise<KalshiMarket[]> {
  const all: KalshiMarket[] = [];
  for (const s of series) {
    const markets = await fetchKalshiOpenMarkets({
      seriesTicker: s,
      maxPages: 5,
    });
    all.push(...markets);
  }
  return all;
}

export { KALSHI_API };
