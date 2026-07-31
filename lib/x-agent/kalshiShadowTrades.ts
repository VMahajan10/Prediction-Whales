import { sql } from "drizzle-orm";
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

const SHADOW_FLOAT_DECIMALS = 6;

/** Coerce to a finite Postgres float (double precision) without IEEE noise. */
export function toShadowFloat(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid shadow trade float: ${value}`);
  }
  return Number.parseFloat(value.toFixed(SHADOW_FLOAT_DECIMALS));
}

/** Strip non-JSON values and produce a driver-safe jsonb object. */
export function serializeShadowPayload(
  payload: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (payload == null) return null;
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

function timestampToDate(timestamp: number): Date {
  const ms = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  return new Date(ms);
}

type ShadowInsertRow = ReturnType<typeof buildKalshiShadowTradeRow>;

export function buildKalshiShadowTradeRow(input: KalshiShadowTradeInput) {
  const serializedPayload = serializeShadowPayload(input.rawPayload);

  return {
    tradeId: input.tradeId.trim(),
    ticker: input.ticker.trim(),
    size: toShadowFloat(input.size),
    tradedAt: timestampToDate(input.timestamp),
    entryPrice: toShadowFloat(input.entryPrice),
    takerSide: input.takerSide ?? null,
    takerOutcomeSide: input.takerOutcomeSide ?? null,
    takerBookSide: input.takerBookSide ?? null,
    isBlockTrade: input.isBlockTrade === true,
    usdNotional:
      input.usdNotional == null ? null : toShadowFloat(input.usdNotional),
    rawPayload: serializedPayload,
  };
}

function shadowInsertValues(row: ShadowInsertRow) {
  return {
    ...row,
    rawPayload:
      row.rawPayload != null
        ? sql`${JSON.stringify(row.rawPayload)}::jsonb`
        : null,
  };
}

type PgErrorShape = {
  message: string;
  stack?: string;
  code?: string;
  detail?: string;
  constraint?: string;
};

export function formatShadowInsertError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const pg = error as Error & PgErrorShape;
  const details: Record<string, unknown> = {
    message: pg.message,
    stack: pg.stack,
  };

  if (pg.code) details.code = pg.code;
  if (pg.detail) details.detail = pg.detail;
  if (pg.constraint) details.constraint = pg.constraint;

  return details;
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

  let row: ShadowInsertRow;
  try {
    row = buildKalshiShadowTradeRow(input);
  } catch (error) {
    console.warn("[kalshi/shadow] row build failed (non-fatal)", {
      tradeId: input.tradeId,
      ticker: input.ticker,
      ...formatShadowInsertError(error),
    });
    return;
  }

  try {
    const db = getDb();
    await db
      .insert(kalshiShadowTrades)
      .values(shadowInsertValues(row))
      .onConflictDoNothing({ target: kalshiShadowTrades.tradeId });
  } catch (error) {
    console.warn(
      "[kalshi/shadow] insert failed (non-fatal)",
      formatShadowInsertError(error),
      { tradeId: row.tradeId, ticker: row.ticker }
    );
  }
}

/** Fire-and-forget shadow log from a WhaleTrade notify payload.
 * Trade-level only — keyed on Kalshi trade_id, never whale_registry. */
export function persistKalshiShadowTradeFromWhale(trade: WhaleTrade): void {
  if (trade.source !== "kalshi" || !trade.ticker?.trim()) return;

  const tradeId = trade.id?.trim();
  if (!tradeId) return;

  const entryPrice = toShadowFloat(trade.price);
  const size =
    entryPrice > 0 && Number.isFinite(trade.usdNotional)
      ? toShadowFloat(trade.usdNotional / entryPrice)
      : toShadowFloat(trade.size);

  void persistKalshiShadowTrade({
    tradeId,
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
