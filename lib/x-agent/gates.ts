import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  type WhaleRegistry,
  xPostLog,
} from "@/lib/crossmarket/store/schema";
import {
  HIGH_EV_TRADE_THRESHOLD_PCT,
  MIN_TRADE_EV_DECIMAL,
  MIN_WALLET_AVG_EV_DECIMAL,
  MIN_WALLET_AVG_EV_THRESHOLD_PCT,
  MIN_WALLET_RESOLVED_BETS,
  STAKE_FLOOR_USD,
  type GateSummary,
  type GateMetricsCollector,
  resolveGateMetricsCollector,
} from "@/lib/x-agent/gateMetrics";
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
  "BELOW_TRADE_EV",
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

export interface TradeGateMatrix {
  /** Live trade EV from pipeline (trade.ev >= 0.03). */
  passesEv: boolean;
  passesStake: boolean;
  /** Wallet registry track record (resolvedBets >= 100, avgEv >= 0.025). */
  passesCredibility: boolean;
  passesAlignment: boolean;
  passesFreshness: boolean;
  passesSource: boolean;
  passesAll: boolean;
  tradeEvDecimal: number | null;
  walletResolvedBets: number | null;
  walletAvgEv: number | null;
  translation?: { side: string; marketPlain: string };
  primaryFailureReason?: GateRejectionReason;
}

export interface TradeEligibilityResult {
  eligible: boolean;
  reason?: GateRejectionReason;
  translation?: { side: string; marketPlain: string };
  matrix: TradeGateMatrix;
}

export interface EvaluateTradeGateMatrixInput {
  trade: TradePayload;
  /** Historical wallet registry row — not seeded from the live trade EV. */
  whale?: WhaleRegistry | null;
  /** Live trade EV as display percent (+3.0 = +3%). */
  tradeEvPercent: number | null;
  nowMs?: number;
}

export interface TradeEligibilityOptions {
  tradeEvPercent?: number | null;
  metrics?: GateSummary | GateMetricsCollector;
}

export const MIN_RESOLVED_BETS = MIN_WALLET_RESOLVED_BETS;
export const MIN_AVG_EV = MIN_WALLET_AVG_EV_DECIMAL;
export const MIN_STAKE_NOTIONAL = STAKE_FLOOR_USD;
export const MAX_TRADE_AGE_MS = 10 * 60 * 1000;

function tradeTimestampMs(timestamp: number): number {
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function formatStake(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

function formatWalletEvPct(avgEv: number): string {
  return (avgEv * 100).toFixed(1);
}

function formatTradeEvPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function logGateCheck(tradeId: string): void {
  console.log("[Gate Check] Trade ID:", tradeId);
}

export function logSourceSkip(): void {
  console.log(
    "[Skip: Source] Trade is from Kalshi (Polymarket required)"
  );
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

function tradeEvPercentToDecimal(tradeEvPercent: number | null): number | null {
  if (tradeEvPercent == null || !Number.isFinite(tradeEvPercent)) return null;
  return tradeEvPercent / 100;
}

function resolvePrimaryFailureReason(
  matrix: TradeGateMatrix,
  whale?: WhaleRegistry | null
): GateRejectionReason {
  if (!matrix.passesSource) return "KALSHI_SOURCE_REJECTED";
  if (!matrix.passesEv) return "BELOW_TRADE_EV";
  if (!matrix.passesStake) return "BELOW_STAKE_FLOOR";
  if (!matrix.passesCredibility) {
    if (
      whale &&
      whale.resolvedBetsCount < MIN_RESOLVED_BETS
    ) {
      return "BELOW_RESOLVED_BETS";
    }
    return "LOW_EV";
  }
  if (!matrix.passesFreshness) return "STALE_TRADE";
  if (!matrix.passesAlignment) return "ILLEGIBLE_MARKET";
  return "BELOW_TRADE_EV";
}

function logGateMatrix(
  trade: TradePayload,
  whale: WhaleRegistry | null | undefined,
  tradeEvPercent: number | null,
  matrix: TradeGateMatrix,
  nowMs: number
): void {
  if (matrix.passesSource) {
    console.log("[Pass: Source] Polymarket trade");
  } else {
    logSourceSkip();
  }

  if (matrix.passesEv) {
    console.log(
      `[Pass: Trade EV] Live trade EV (${formatTradeEvPct(tradeEvPercent ?? 0)}) >= +${HIGH_EV_TRADE_THRESHOLD_PCT}% (trade.ev >= ${MIN_TRADE_EV_DECIMAL})`
    );
  } else {
    console.log(
      tradeEvPercent == null
        ? "[Skip: Trade EV] Live trade EV unavailable"
        : `[Skip: Trade EV] Live trade EV (${formatTradeEvPct(tradeEvPercent)}) < +${HIGH_EV_TRADE_THRESHOLD_PCT}% (trade.ev < ${MIN_TRADE_EV_DECIMAL})`
    );
  }

  if (matrix.passesStake) {
    console.log(
      `[Pass: Stake] ${formatStake(trade.stakeNotional)} >= ${formatStake(MIN_STAKE_NOTIONAL)} threshold`
    );
  } else {
    console.log(
      `[Skip: Stake] ${formatStake(trade.stakeNotional)} < ${formatStake(MIN_STAKE_NOTIONAL)} threshold`
    );
  }

  if (matrix.passesCredibility && whale) {
    console.log(
      `[Pass: Wallet Credibility] Registry track record: resolved bets (${whale.resolvedBetsCount}) >= ${MIN_WALLET_RESOLVED_BETS}, wallet avg EV (${formatWalletEvPct(whale.avgEv)}%) >= +${MIN_WALLET_AVG_EV_THRESHOLD_PCT}%`
    );
  } else {
    console.log("[Credibility Fail]", {
      wallet: trade.walletAddress,
      resolvedBets: whale?.resolvedBetsCount ?? "NOT_IN_DB",
      avgEv: whale?.avgEv ?? "N/A",
    });
  }

  if (matrix.passesAlignment && matrix.translation) {
    console.log(
      `[Pass: Alignment] Translated to "${matrix.translation.side}" on "${matrix.translation.marketPlain}"`
    );
  } else {
    console.log(
      "[Skip: Alignment] Market cannot be translated to plain-English side"
    );
  }

  const tradeAgeMs = nowMs - tradeTimestampMs(trade.timestamp);
  if (matrix.passesFreshness) {
    console.log(
      `[Pass: Freshness] Trade age (${Math.round(tradeAgeMs / 60_000)}m) within ${MAX_TRADE_AGE_MS / 60_000}m window`
    );
  } else {
    const ageMin = Math.round(tradeAgeMs / 60_000);
    console.log(
      `[Skip: Freshness] Trade age (${ageMin}m) > ${MAX_TRADE_AGE_MS / 60_000}m threshold`
    );
  }
}

/**
 * Evaluate every post-queue gate independently (no short-circuit).
 */
export function evaluateTradeGateMatrix(
  input: EvaluateTradeGateMatrixInput
): TradeGateMatrix {
  const { trade, whale, tradeEvPercent } = input;
  const nowMs = input.nowMs ?? Date.now();

  const tradeEvDecimal = tradeEvPercentToDecimal(tradeEvPercent);
  const walletResolvedBets = whale?.resolvedBetsCount ?? null;
  const walletAvgEv = whale?.avgEv ?? null;

  const passesSource = trade.source === "polymarket";
  const passesEv =
    tradeEvDecimal != null && tradeEvDecimal >= MIN_TRADE_EV_DECIMAL;
  const passesStake = trade.stakeNotional >= MIN_STAKE_NOTIONAL;
  const passesCredibility =
    whale != null &&
    whale.resolvedBetsCount >= MIN_WALLET_RESOLVED_BETS &&
    whale.avgEv >= MIN_WALLET_AVG_EV_DECIMAL;

  const translation =
    passesSource && translateMarketAndSide(toRawPolymarketTrade(trade));
  const passesAlignment = Boolean(translation);

  const tradeAgeMs = nowMs - tradeTimestampMs(trade.timestamp);
  const passesFreshness = tradeAgeMs <= MAX_TRADE_AGE_MS;

  const passesAll =
    passesEv &&
    passesStake &&
    passesCredibility &&
    passesAlignment &&
    passesFreshness &&
    passesSource;

  const matrix: TradeGateMatrix = {
    passesEv,
    passesStake,
    passesCredibility,
    passesAlignment,
    passesFreshness,
    passesSource,
    passesAll,
    tradeEvDecimal,
    walletResolvedBets,
    walletAvgEv,
    translation: translation || undefined,
  };

  if (!passesAll) {
    matrix.primaryFailureReason = resolvePrimaryFailureReason(matrix, whale);
  }

  return matrix;
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

/**
 * Run full gate-matrix eligibility for a whale trade.
 * All gates are evaluated; metrics record every failure independently.
 */
export async function evaluateTradeEligibility(
  trade: TradePayload,
  whale: WhaleRegistry | null | undefined,
  nowMs = Date.now(),
  options?: TradeEligibilityOptions
): Promise<TradeEligibilityResult> {
  logGateCheck(trade.tradeId);

  const matrix = evaluateTradeGateMatrix({
    trade,
    whale,
    tradeEvPercent: options?.tradeEvPercent ?? null,
    nowMs,
  });

  logGateMatrix(trade, whale, options?.tradeEvPercent ?? null, matrix, nowMs);

  const metricsCollector = resolveGateMetricsCollector(options?.metrics);
  if (metricsCollector) {
    metricsCollector.recordGateMatrixFailures(matrix, whale);
  }

  if (!matrix.passesAll) {
    const reason =
      matrix.primaryFailureReason ??
      resolvePrimaryFailureReason(matrix, whale);
    await logGateFailure(trade, reason);
    return { eligible: false, reason, matrix };
  }

  return { eligible: true, translation: matrix.translation, matrix };
}
