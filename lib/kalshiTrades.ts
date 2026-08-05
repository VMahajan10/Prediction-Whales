import { resolveKalshiMarkets } from "@/lib/kalshiTitleResolver";
import { kalshiFetch } from "@/lib/kalshi/http";
import { persistKalshiShadowTrade } from "@/lib/x-agent/kalshiShadowTrades";

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
  slug?: string;
  /** Kalshi contract selection (player, line, prop) — not Yes/No side. */
  selectionLabel?: string;
  /** Polymarket CLOB token id (YES leg) for pipeline EV lookup. */
  assetId?: string;
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

export type { KalshiRawTrade };

function shadowInputFromRaw(
  raw: KalshiRawTrade,
  normalized: FeedTrade
): Parameters<typeof persistKalshiShadowTrade>[0] {
  return {
    tradeId: raw.trade_id,
    ticker: raw.ticker,
    size: normalized.size,
    timestamp: normalized.timestamp,
    entryPrice: normalized.price,
    takerSide: raw.taker_side,
    takerOutcomeSide: raw.taker_outcome_side ?? null,
    takerBookSide: raw.taker_book_side ?? null,
    isBlockTrade: raw.is_block_trade === true,
    usdNotional: normalized.usdNotional,
    rawPayload: raw as unknown as Record<string, unknown>,
  };
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
  market: { eventTitle: string; selectionLabel?: string | null },
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
    title: market.eventTitle,
    outcome,
    side: raw.taker_book_side === "ask" ? "SELL" : "BUY",
    price,
    size,
    usdNotional,
    timestamp: parseTimestamp(raw.created_time, nowEpochSeconds),
    traceable: true,
    ticker: raw.ticker,
    selectionLabel: market.selectionLabel ?? undefined,
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

  const res = await kalshiFetch(`/markets/trades?${params}`, {
    next: { revalidate: 0 },
    label: "markets/trades",
  });

  if (!res.ok) {
    throw new Error(`Kalshi trades API error: ${res.status} ${res.statusText}`);
  }

  const data: unknown = await res.json();
  if (!data || typeof data !== "object" || !Array.isArray((data as { trades?: unknown }).trades)) {
    return [];
  }

  const raws = (data as { trades: KalshiRawTrade[] }).trades;
  const tickers = raws.map((raw) => raw.ticker).filter(Boolean);
  const marketCache = await resolveKalshiMarkets(tickers);
  const trades: FeedTrade[] = [];

  for (const raw of raws) {
    if (!raw?.trade_id || !raw?.ticker) continue;

    const cached = marketCache.get(raw.ticker);
    const market = cached ?? {
      eventTitle: raw.ticker,
      selectionLabel: null,
    };

    const normalized = normalizeKalshiTrade(raw, market, nowEpochSeconds);
    if (!normalized) continue;

    void persistKalshiShadowTrade(shadowInputFromRaw(raw, normalized));
    trades.push(normalized);
  }

  return trades;
}
