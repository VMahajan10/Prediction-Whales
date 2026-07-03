import type { TradeSummary } from "@/lib/polymarket";

export const MIN_WHALE_USD = 500;
export const WHALE_WINDOW_MS = 90_000;

export interface WhaleTrade extends TradeSummary {
  source: "polymarket" | "kalshi";
  /** USD notional (size × price for WS trades) */
  usdNotional: number;
  /** When MarketPulse first detected this trade */
  detectedAt: number;
  isLive: boolean;
  /** Kalshi market ticker when source is kalshi */
  ticker?: string;
  /** Pre-computed pipeline average EV % (from backend enrichment). */
  averageEv?: number | null;
  netEvPercent?: number | null;
  grossEvPercent?: number | null;
}

export function isWhaleNotional(usd: number): boolean {
  return usd >= MIN_WHALE_USD;
}

export function mergeWhaleTrades(
  live: WhaleTrade[],
  backfill: WhaleTrade[]
): WhaleTrade[] {
  const byHash = new Map<string, WhaleTrade>();

  for (const trade of backfill) {
    const key = trade.transactionHash || trade.id;
    if (key) byHash.set(key, trade);
  }

  for (const trade of live) {
    const key = trade.transactionHash || trade.id;
    if (!key) continue;
    const existing = byHash.get(key);
    byHash.set(
      key,
      existing ? { ...existing, ...trade, isLive: true } : trade
    );
  }

  return Array.from(byHash.values()).sort(
    (a, b) => b.detectedAt - a.detectedAt
  );
}

export function tradeToWhale(
  trade: TradeSummary,
  opts: {
    detectedAt?: number;
    isLive?: boolean;
    usdNotional?: number;
    source?: "polymarket" | "kalshi";
    ticker?: string;
  }
): WhaleTrade {
  const usd = opts.usdNotional ?? trade.size;

  return {
    ...trade,
    source: opts.source ?? "polymarket",
    usdNotional: usd,
    detectedAt: opts.detectedAt ?? trade.timestamp * 1000,
    isLive: opts.isLive ?? false,
    size: usd,
    ticker: opts.ticker,
  };
}

export function windowProgress(detectedAt: number, now = Date.now()): number {
  const elapsed = now - detectedAt;
  return Math.min(100, Math.max(0, (elapsed / WHALE_WINDOW_MS) * 100));
}

export function windowRemainingSec(detectedAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((WHALE_WINDOW_MS - (now - detectedAt)) / 1000));
}
