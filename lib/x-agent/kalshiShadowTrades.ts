import { sql } from "drizzle-orm";
import "server-only";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { kalshiShadowTrades } from "@/lib/crossmarket/store/schema";
import {
  meetsFeedTradeEvThreshold,
  meetsProductFeedStakeThreshold,
} from "@/lib/feedQualification";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import type { WhaleTrade } from "@/lib/whaleTrades";

/** Batched Neon flush cadence for Kalshi shadow trade inserts. */
export const KALSHI_SHADOW_FLUSH_INTERVAL_MS = 20_000;

export interface KalshiShadowTradeInput {
  tradeId: string;
  ticker: string;
  size: number | string;
  /** Unix epoch seconds. */
  timestamp: number;
  entryPrice: number | string;
  takerSide?: string | null;
  takerOutcomeSide?: string | null;
  takerBookSide?: string | null;
  isBlockTrade?: boolean;
  usdNotional?: number | string | null;
  rawPayload?: Record<string, unknown> | null;
}

const SHADOW_FLOAT_DECIMALS = 6;

/** Coerce API strings / floats to a finite Postgres double precision value. */
export function toShadowFloat(value: number | string): number {
  const numeric =
    typeof value === "string" ? Number.parseFloat(value.trim()) : value;
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid shadow trade float: ${value}`);
  }
  return Number.parseFloat(numeric.toFixed(SHADOW_FLOAT_DECIMALS));
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
  cause?: unknown;
};

function readErrorCauseMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = (error as Error & PgErrorShape).cause;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return undefined;
}

export function formatShadowInsertError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  const pg = error as Error & PgErrorShape;
  const causeMessage = readErrorCauseMessage(error);
  const details: Record<string, unknown> = {
    message: pg.message,
    stack: pg.stack,
  };

  if (causeMessage) details.cause = causeMessage;
  if (pg.code) details.code = pg.code;
  if (pg.detail) details.detail = pg.detail;
  if (pg.constraint) details.constraint = pg.constraint;

  return details;
}

const pendingShadowRows = new Map<string, ShadowInsertRow>();
let shadowFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleKalshiShadowFlush(): void {
  if (shadowFlushTimer) return;
  shadowFlushTimer = setTimeout(() => {
    shadowFlushTimer = null;
    void flushKalshiShadowTradeBatch();
  }, KALSHI_SHADOW_FLUSH_INTERVAL_MS);
}

/**
 * Queue a pre-qualified Kalshi shadow row for batched Neon flush.
 * Callers must gate on stake + trade EV before queueing.
 */
export function queueKalshiShadowTrade(input: KalshiShadowTradeInput): void {
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

  pendingShadowRows.set(row.tradeId, row);
  scheduleKalshiShadowFlush();
}

export async function flushKalshiShadowTradeBatch(): Promise<void> {
  if (!isDatabaseEnabled() || pendingShadowRows.size === 0) return;

  const rows = Array.from(pendingShadowRows.values());
  pendingShadowRows.clear();

  try {
    const db = getDb();
    await db
      .insert(kalshiShadowTrades)
      .values(rows.map((row) => shadowInsertValues(row)))
      .onConflictDoNothing({ target: kalshiShadowTrades.tradeId });
  } catch (error) {
    const details = formatShadowInsertError(error);
    const causeMessage = readErrorCauseMessage(error);
    console.warn(
      `[kalshi/shadow] batch insert failed (non-fatal) count=${rows.length}: ${details.message ?? "unknown"}${causeMessage ? ` | cause: ${causeMessage}` : ""}`,
      details
    );
  }
}

/**
 * Persist a Kalshi trade event for internal shadow P&L tracking.
 * Dedupes on trade_id — batched flush every ~20s.
 * Trade-level only; never joined to whale_registry (OQ-2).
 */
export async function persistKalshiShadowTrade(
  input: KalshiShadowTradeInput
): Promise<void> {
  queueKalshiShadowTrade(input);
}

/** Fire-and-forget shadow log from a WhaleTrade notify payload.
 * Trade-level only — keyed on Kalshi trade_id, never whale_registry. */
export function persistKalshiShadowTradeFromWhale(trade: WhaleTrade): void {
  if (trade.source !== "kalshi" || !trade.ticker?.trim()) return;

  const tradeId = trade.id?.trim();
  if (!tradeId) return;

  if (!meetsProductFeedStakeThreshold(trade.usdNotional)) return;

  const tradeEvPercent = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    null
  );
  if (!meetsFeedTradeEvThreshold(tradeEvPercent)) return;

  const entryPrice = toShadowFloat(trade.price);
  const size =
    entryPrice > 0 && Number.isFinite(trade.usdNotional)
      ? toShadowFloat(trade.usdNotional / entryPrice)
      : toShadowFloat(trade.size);

  queueKalshiShadowTrade({
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
      netEvPercent: tradeEvPercent,
    },
  });
}
