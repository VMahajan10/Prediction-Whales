import type { TradeSummary } from "@/lib/polymarket";
import type { ResolvedWhaleIdentity } from "@/lib/whaleIdentityResolver";
import type { MarketPositionTranslation } from "@/lib/marketTranslator";
import { MIN_STAKE_THRESHOLD } from "@/lib/feedQualification";

export const MIN_WHALE_USD = MIN_STAKE_THRESHOLD;
export const WHALE_WINDOW_MS = 90_000;

export interface WhaleTrade extends TradeSummary {
  source: "polymarket" | "kalshi";
  /** Uppercase platform tag for UI filters / API payloads (alongside `source`). */
  platform?: "KALSHI" | "POLYMARKET";
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
  /** Registry-backed whale identity and track-record stats for feed cards. */
  whaleIdentity?: ResolvedWhaleIdentity;
  /** Plain-language market position copy for feed cards. */
  marketTranslation?: MarketPositionTranslation;
  /** Kalshi contract selection label (player, line, prop). */
  selectionLabel?: string;
  /** Normalized feed category from ingestion (SPORTS, POLITICS, CULTURE, OTHER). */
  category?: string;
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

  const source = opts.source ?? "polymarket";

  return {
    ...trade,
    source,
    platform: source === "kalshi" ? "KALSHI" : "POLYMARKET",
    usdNotional: usd,
    detectedAt: opts.detectedAt ?? trade.timestamp * 1000,
    isLive: opts.isLive ?? false,
    size: trade.size,
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
