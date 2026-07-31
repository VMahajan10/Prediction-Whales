import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { kalshiShadowTrades } from "@/lib/crossmarket/store/schema";
import type { WhaleTrade } from "@/lib/whaleTrades";

export interface KalshiShadowTradeInput {
  tradeId: string;
  ticker: string;
  size: number;
  /** Unix epoch seconds. */
  timestamp: number;
  entryPrice: number;
  takerSide?: string | null;
  takerOutcomeSide?: string | null;
  takerBookSide?: string | null;
  isBlockTrade?: boolean;
  usdNotional?: number | null;
  rawPayload?: Record<string, unknown> | null;
}

function timestampToDate(timestamp: number): Date {
  const ms = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  return new Date(ms);
}

export function buildKalshiShadowTradeRow(input: KalshiShadowTradeInput) {
  return {
    tradeId: input.tradeId,
    ticker: input.ticker,
    size: input.size,
    tradedAt: timestampToDate(input.timestamp),
    entryPrice: input.entryPrice,
    takerSide: input.takerSide ?? null,
    takerOutcomeSide: input.takerOutcomeSide ?? null,
    takerBookSide: input.takerBookSide ?? null,
    isBlockTrade: input.isBlockTrade === true,
    usdNotional: input.usdNotional ?? null,
    rawPayload: input.rawPayload ?? null,
  };
}

/**
 * Persist a Kalshi trade event for internal shadow P&L tracking.
 * Dedupes on trade_id — safe to call on every poll/notify.
 * Trade-level only; never joined to whale_registry (OQ-2).
 */
export async function persistKalshiShadowTrade(
  input: KalshiShadowTradeInput
): Promise<void> {
  if (!input.tradeId?.trim() || !input.ticker?.trim()) return;
  if (!isDatabaseEnabled()) return;

  try {
    const db = getDb();
    await db
      .insert(kalshiShadowTrades)
      .values(buildKalshiShadowTradeRow(input))
      .onConflictDoNothing({ target: kalshiShadowTrades.tradeId });
  } catch (error) {
    console.warn("[kalshi/shadow] insert failed (non-fatal)", {
      tradeId: input.tradeId,
      error: error instanceof Error ? error.message : error,
    });
  }
}

/** Fire-and-forget shadow log from a WhaleTrade notify payload. */
export function persistKalshiShadowTradeFromWhale(trade: WhaleTrade): void {
  if (trade.source !== "kalshi" || !trade.ticker?.trim()) return;

  const entryPrice = trade.price;
  const size =
    entryPrice > 0 && Number.isFinite(trade.usdNotional)
      ? trade.usdNotional / entryPrice
      : trade.size;

  void persistKalshiShadowTrade({
    tradeId: trade.id,
    ticker: trade.ticker,
    size,
    timestamp: trade.timestamp,
    entryPrice,
    usdNotional: trade.usdNotional,
    rawPayload: {
      title: trade.title,
      outcome: trade.outcome,
      side: trade.side,
      detectedAt: trade.detectedAt,
      isLive: trade.isLive,
    },
  });
}
