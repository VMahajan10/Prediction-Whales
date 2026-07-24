import { and, eq, gte, inArray } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  type WhaleRegistry,
  xPostLog,
  xPostQueue,
} from "@/lib/crossmarket/store/schema";
import {
  translateMarketAndSide,
  type RawPolymarketTrade,
} from "@/lib/x-agent/translator";

export const GATE_REJECTION_REASONS = [
  "KALSHI_SOURCE_REJECTED",
  "BELOW_RESOLVED_BETS",
  "LOW_EV",
  "BELOW_STAKE_FLOOR",
  "STALE_TRADE",
  "LINE_DRIFT_EXCEEDED",
  "ILLEGIBLE_MARKET",
  "DUPLICATE_TRADE",
  "RECENT_MARKET_POST",
] as const;

export type GateRejectionReason = (typeof GATE_REJECTION_REASONS)[number];

export interface TradePayload {
  source: "polymarket" | "kalshi";
  tradeId: string;
  walletAddress: string;
  stakeNotional: number;
  /** Unix epoch seconds. */
  timestamp: number;
  entryCents: number;
  nowCents: number;
  title: string;
  outcome: string;
  side: "BUY" | "SELL";
  marketSlug: string;
  slug?: string | null;
  eventSlug?: string | null;
}

export interface TradeEligibilityResult {
  eligible: boolean;
  reason?: GateRejectionReason;
  translation?: { side: string; marketPlain: string };
}

export interface TradeEligibilityOptions {
  /** Skip registry track-record gates for wallets auto-registered from a high-EV trade. */
  skipWhaleStatGates?: boolean;
}

const MIN_RESOLVED_BETS = 500;
const MIN_AVG_EV = 0.03;
const MIN_STAKE_NOTIONAL = 25_000;
const MAX_TRADE_AGE_MS = 10 * 60 * 1000;
const MAX_LINE_DRIFT_CENTS = 5;
const MARKET_DEDUPE_WINDOW_MS = 45 * 60 * 1000;

const ACTIVE_QUEUE_STATUSES = [
  "PENDING_REVIEW",
  "APPROVED",
  "EDITED",
  "DISPATCHED",
] as const;

function tradeTimestampMs(timestamp: number): number {
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

async function logGateFailure(
  trade: TradePayload,
  reason: GateRejectionReason
): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.warn("[x-agent/gates] gate rejected (db disabled)", {
      tradeId: trade.tradeId,
      reason,
    });
    return;
  }

  try {
    const db = getDb();
    await db.insert(xPostLog).values({
      tradeId: trade.tradeId,
      gatePassed: false,
      rejectionReason: reason,
      payload: trade,
    });
  } catch (error) {
    console.error("[DB WRITE ERROR]", error);
    throw error;
  }
}

async function reject(
  trade: TradePayload,
  reason: GateRejectionReason
): Promise<TradeEligibilityResult> {
  await logGateFailure(trade, reason);
  return { eligible: false, reason };
}

function toRawPolymarketTrade(trade: TradePayload): RawPolymarketTrade {
  return {
    source: trade.source,
    title: trade.title,
    outcome: trade.outcome,
    side: trade.side,
    slug: trade.slug,
    eventSlug: trade.eventSlug,
  };
}

async function hasDuplicateTrade(tradeId: string): Promise<boolean> {
  if (!isDatabaseEnabled()) return false;

  const db = getDb();
  const [queued] = await db
    .select({ id: xPostQueue.id })
    .from(xPostQueue)
    .where(eq(xPostQueue.tradeId, tradeId))
    .limit(1);
  if (queued) return true;

  const [logged] = await db
    .select({ id: xPostLog.id })
    .from(xPostLog)
    .where(eq(xPostLog.tradeId, tradeId))
    .limit(1);

  return !!logged;
}

async function hasRecentMarketPost(marketSlug: string): Promise<boolean> {
  if (!isDatabaseEnabled()) return false;

  const cutoff = new Date(Date.now() - MARKET_DEDUPE_WINDOW_MS);
  const db = getDb();

  const [queued] = await db
    .select({ id: xPostQueue.id })
    .from(xPostQueue)
    .where(
      and(
        eq(xPostQueue.marketSlug, marketSlug),
        gte(xPostQueue.createdAt, cutoff),
        inArray(xPostQueue.status, [...ACTIVE_QUEUE_STATUSES])
      )
    )
    .limit(1);

  return !!queued;
}

/**
 * Run strict X-post eligibility gates for a whale trade.
 * Failed checks are persisted to `x_post_log` with a rejection reason.
 */
export async function evaluateTradeEligibility(
  trade: TradePayload,
  whale: WhaleRegistry,
  nowMs = Date.now(),
  options?: TradeEligibilityOptions
): Promise<TradeEligibilityResult> {
  if (trade.source !== "polymarket") {
    return reject(trade, "KALSHI_SOURCE_REJECTED");
  }

  if (!options?.skipWhaleStatGates) {
    if (whale.resolvedBetsCount < MIN_RESOLVED_BETS) {
      return reject(trade, "BELOW_RESOLVED_BETS");
    }

    if (whale.avgEv < MIN_AVG_EV) {
      return reject(trade, "LOW_EV");
    }
  }

  if (trade.stakeNotional < MIN_STAKE_NOTIONAL) {
    return reject(trade, "BELOW_STAKE_FLOOR");
  }

  const tradeAgeMs = nowMs - tradeTimestampMs(trade.timestamp);
  if (tradeAgeMs > MAX_TRADE_AGE_MS) {
    return reject(trade, "STALE_TRADE");
  }

  const lineDrift = Math.abs(trade.nowCents - trade.entryCents);
  if (lineDrift > MAX_LINE_DRIFT_CENTS) {
    return reject(trade, "LINE_DRIFT_EXCEEDED");
  }

  const translation = translateMarketAndSide(toRawPolymarketTrade(trade));
  if (!translation) {
    return reject(trade, "ILLEGIBLE_MARKET");
  }

  if (await hasDuplicateTrade(trade.tradeId)) {
    return reject(trade, "DUPLICATE_TRADE");
  }

  if (await hasRecentMarketPost(trade.marketSlug)) {
    return reject(trade, "RECENT_MARKET_POST");
  }

  return { eligible: true, translation };
}
