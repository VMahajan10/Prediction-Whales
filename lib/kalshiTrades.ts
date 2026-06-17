import { resolveKalshiTitle } from "@/lib/kalshiTitleResolver";

const KALSHI_TRADES_URL =
  "https://api.elections.kalshi.com/trade-api/v2/markets/trades";

export interface FeedTrade {
  id: string;
  source: "polymarket" | "kalshi";
  title: string;
  outcome: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  usdNotional: number;
  timestamp: number;
  traceable: boolean;
  transactionHash?: string;
  ticker?: string;
  isBlockTrade?: boolean;
}

interface KalshiRawTrade {
  trade_id: string;
  ticker: string;
  created_time: string;
  count_fp: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  taker_side: "yes" | "no";
  taker_outcome_side?: "yes" | "no";
  taker_book_side?: "bid" | "ask";
  is_block_trade?: boolean;
}

const SKEW_TOLERANCE_SEC = 5;

function parseTimestamp(createdTime: string, nowEpochSeconds: number): number {
  const parsed = Math.floor(Date.parse(createdTime) / 1000);
  if (!Number.isFinite(parsed)) return nowEpochSeconds;
  if (parsed > nowEpochSeconds + SKEW_TOLERANCE_SEC) {
    return nowEpochSeconds;
  }
  return parsed;
}

function normalizeKalshiTrade(
  raw: KalshiRawTrade,
  title: string,
  nowEpochSeconds: number
): FeedTrade | null {
  const price =
    raw.taker_side === "yes"
      ? parseFloat(raw.yes_price_dollars)
      : parseFloat(raw.no_price_dollars);
  const size = parseFloat(raw.count_fp);

  if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) {
    return null;
  }

  const usdNotional = price * size;
  if (!Number.isFinite(usdNotional) || usdNotional <= 0) return null;

  const outcome =
    (raw.taker_outcome_side ?? raw.taker_side) === "yes" ? "Yes" : "No";

  return {
    id: raw.trade_id,
    source: "kalshi",
    title,
    outcome,
    side: raw.taker_book_side === "ask" ? "SELL" : "BUY",
    price,
    size,
    usdNotional,
    timestamp: parseTimestamp(raw.created_time, nowEpochSeconds),
    traceable: false,
    ticker: raw.ticker,
    isBlockTrade: raw.is_block_trade === true,
  };
}

export async function fetchKalshiTrades(
  minTs?: number
): Promise<FeedTrade[]> {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({ limit: "100" });
  if (minTs != null && minTs > 0) {
    params.set("min_ts", String(minTs));
  }

  const res = await fetch(`${KALSHI_TRADES_URL}?${params}`, {
    headers: { Accept: "application/json" },
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    throw new Error(`Kalshi trades API error: ${res.status} ${res.statusText}`);
  }

  const data: unknown = await res.json();
  if (!data || typeof data !== "object" || !Array.isArray((data as { trades?: unknown }).trades)) {
    return [];
  }

  const raws = (data as { trades: KalshiRawTrade[] }).trades;
  const titleCache = new Map<string, string>();
  const trades: FeedTrade[] = [];

  for (const raw of raws) {
    if (!raw?.trade_id || !raw?.ticker) continue;

    let title = titleCache.get(raw.ticker);
    if (!title) {
      title = await resolveKalshiTitle(raw.ticker);
      titleCache.set(raw.ticker, title);
    }

    const normalized = normalizeKalshiTrade(raw, title, nowEpochSeconds);
    if (normalized) trades.push(normalized);
  }

  return trades;
}
