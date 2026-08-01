import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  type WhaleRegistry,
  xPostLog,
} from "@/lib/crossmarket/store/schema";
import {
  CREDIBILITY_CONFIG,
} from "@/lib/feedQualification";
import {
  HIGH_EV_TRADE_THRESHOLD_PCT,
  MIN_TRADE_EV_DECIMAL,
  MIN_WALLET_AVG_EV_DECIMAL,
  MIN_WALLET_AVG_EV_THRESHOLD_PCT,
  MIN_WALLET_RESOLVED_BETS,
  meetsResolvedBetsThreshold,
  STAKE_FLOOR_USD,
  type GateSummary,
  type GateMetricsCollector,
  resolveGateMetricsCollector,
} from "@/lib/x-agent/gateMetrics";
import {
  formatStakeFloorTierLabel,
  resolveStakeFloorUsd,
  type StakeFloorTier,
} from "@/lib/x-agent/stakeFloor";
import {
  translateMarketAndSide,
  type RawPolymarketTrade,
} from "@/lib/x-agent/translator";
import {
  KALSHI_PUBLIC_POSTING_DISABLED_REASON,
  isPostQueueSourceAllowed,
  logPostQueueSourceSkip,
  evaluatePostQueueCredibilityGate,
  evaluatePostQueueMarketTranslationGate,
  shouldApplyShadowCredibilityOverride,
  STAKE_TOO_LOW,
  BELOW_EV_THRESHOLD,
} from "@/lib/x-agent/postQueueGates";
import { isAnonymousWalletAddress } from "@/lib/x-agent/whaleRegistryDb";

export {
  KALSHI_PUBLIC_POSTING_DISABLED,
  KALSHI_PUBLIC_POSTING_DISABLED_REASON,
  STAKE_TOO_LOW,
  BELOW_EV_THRESHOLD,
} from "@/lib/x-agent/postQueueGates";

export const GATE_REJECTION_REASONS = [
  "KALSHI_PUBLIC_POSTING_DISABLED",
  "BELOW_RESOLVED_BETS",
  "BELOW_EV_THRESHOLD",
  "LOW_EV",
  "STAKE_TOO_LOW",
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
  /** Live trade EV from pipeline (trade.ev >= 0.025). */
  passesEv: boolean;
  passesStake: boolean;
  /** Wallet registry track record (resolvedBets >= 300, avgEv >= 0.03). */
  passesCredibility: boolean;
  passesAlignment: boolean;
  passesFreshness: boolean;
  passesSource: boolean;
  passesAll: boolean;
  tradeEvDecimal: number | null;
  walletResolvedBets: number | null;
  walletAvgEv: number | null;
  stakeFloorUsd?: number;
  stakeFloorTier?: StakeFloorTier;
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
  /** Live trade EV as display percent (+2.5 = +2.5%). */
  tradeEvPercent: number | null;
  nowMs?: number;
}

export interface TradeEligibilityOptions {
  tradeEvPercent?: number | null;
  metrics?: GateSummary | GateMetricsCollector;
}

export type PreGateStep =
  | "source"
  | "freshness"
  | "stake"
  | "alignment"
  | "credibility"
  | "dedupe"
  | "trade_ev";

export interface PreGateShortCircuitResult {
  passed: boolean;
  reason?: GateRejectionReason;
  failedStep?: PreGateStep;
  translation?: { side: string; marketPlain: string };
}

export const MIN_RESOLVED_BETS = MIN_WALLET_RESOLVED_BETS;
export const MIN_RESOLVED_THRESHOLD = MIN_WALLET_RESOLVED_BETS;
export const MIN_AVG_EV = MIN_WALLET_AVG_EV_DECIMAL;
/** Default-tier stake floor; tiered floors use `resolveStakeFloorUsd()`. */
export const MIN_STAKE_NOTIONAL = STAKE_FLOOR_USD;
export const MAX_TRADE_AGE_MS = 30 * 60 * 1000;

function gateLog(tradeId: string, message: string): void {
  console.log(`[Gate] tradeId=${tradeId} ${message}`);
}

function resolveTradeStakeFloor(trade: TradePayload) {
  return resolveStakeFloorUsd(trade.title, trade.slug, trade.eventSlug);
}

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
  gateLog(tradeId, "evaluating post-queue gates");
}

export function logSourceSkip(tradeId?: string): void {
  logPostQueueSourceSkip(tradeId);
}

function logStakeGate(
  trade: TradePayload,
  passed: boolean,
  stakeFloorUsd: number,
  tier: StakeFloorTier
): void {
  const tierLabel = formatStakeFloorTierLabel(tier);
  if (passed) {
    gateLog(
      trade.tradeId,
      `[Pass: Stake] ${formatStake(trade.stakeNotional)} >= ${formatStake(stakeFloorUsd)} (${tierLabel} tier)`
    );
  } else {
    gateLog(
      trade.tradeId,
      `[Fail: Stake] ${formatStake(trade.stakeNotional)} < ${formatStake(stakeFloorUsd)} (${tierLabel} tier)`
    );
  }
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
  if (!matrix.passesSource) return KALSHI_PUBLIC_POSTING_DISABLED_REASON;
  if (!matrix.passesEv) return "BELOW_TRADE_EV";
  if (!matrix.passesStake) return "BELOW_STAKE_FLOOR";
  if (!matrix.passesCredibility) {
    if (!whale || !meetsResolvedBetsThreshold(whale.resolvedBetsCount)) {
      return "BELOW_RESOLVED_BETS";
    }
    return BELOW_EV_THRESHOLD;
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
  const stakeFloorUsd = matrix.stakeFloorUsd ?? MIN_STAKE_NOTIONAL;
  const stakeTier = matrix.stakeFloorTier ?? "default";

  if (matrix.passesSource) {
    gateLog(trade.tradeId, "[Pass: Source] Polymarket trade");
  } else {
    logSourceSkip(trade.tradeId);
  }

  if (matrix.passesEv) {
    gateLog(
      trade.tradeId,
      `[Pass: Trade EV] Live trade EV (${formatTradeEvPct(tradeEvPercent ?? 0)}) >= +${HIGH_EV_TRADE_THRESHOLD_PCT}% (trade.ev >= ${MIN_TRADE_EV_DECIMAL})`
    );
  } else {
    gateLog(
      trade.tradeId,
      tradeEvPercent == null
        ? "[Fail: Trade EV] Live trade EV unavailable"
        : `[Fail: Trade EV] Live trade EV (${formatTradeEvPct(tradeEvPercent)}) < +${HIGH_EV_TRADE_THRESHOLD_PCT}% (trade.ev < ${MIN_TRADE_EV_DECIMAL})`
    );
  }

  logStakeGate(trade, matrix.passesStake, stakeFloorUsd, stakeTier);

  if (isAnonymousWalletAddress(trade.walletAddress)) {
    gateLog(
      trade.tradeId,
      "[Fail: Credibility] Anonymous wallet has no resolved bet history"
    );
  } else if (matrix.passesCredibility && whale) {
    gateLog(
      trade.tradeId,
      `[Pass: Wallet Credibility] Registry track record: resolved bets (${whale.resolvedBetsCount}) >= ${MIN_WALLET_RESOLVED_BETS}, wallet avg EV (${formatWalletEvPct(whale.avgEv)}%) >= +${MIN_WALLET_AVG_EV_THRESHOLD_PCT}%`
    );
  } else {
    gateLog(
      trade.tradeId,
      `[Fail: Wallet Credibility] wallet=${trade.walletAddress} resolvedBetCount=${whale?.resolvedBetsCount ?? "NOT_IN_DB"} avgEv=${whale?.avgEv ?? "N/A"}`
    );
  }

  if (matrix.passesAlignment && matrix.translation) {
    gateLog(
      trade.tradeId,
      `[Pass: Alignment] Translated to "${matrix.translation.side}" on "${matrix.translation.marketPlain}"`
    );
  } else {
    gateLog(
      trade.tradeId,
      "[Fail: Alignment] Market cannot be translated to plain-English side"
    );
  }

  const tradeAgeMs = nowMs - tradeTimestampMs(trade.timestamp);
  if (matrix.passesFreshness) {
    gateLog(
      trade.tradeId,
      `[Pass: Freshness] Trade age (${Math.round(tradeAgeMs / 60_000)}m) within ${MAX_TRADE_AGE_MS / 60_000}m window`
    );
  } else {
    const ageMin = Math.round(tradeAgeMs / 60_000);
    gateLog(
      trade.tradeId,
      `[Fail: Freshness] Trade age (${ageMin}m) > ${MAX_TRADE_AGE_MS / 60_000}m threshold`
    );
  }

  if (matrix.passesAll) {
    gateLog(trade.tradeId, "[Pass: All Gates] Trade eligible for x_post_queue");
  } else {
    gateLog(
      trade.tradeId,
      `[Fail: Gate Matrix] Primary rejection: ${matrix.primaryFailureReason ?? "unknown"}`
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

  const passesSource = isPostQueueSourceAllowed(trade.source);
  const passesEv =
    tradeEvDecimal != null && tradeEvDecimal >= MIN_TRADE_EV_DECIMAL;
  const stakeFloor = resolveTradeStakeFloor(trade);
  const passesStake = trade.stakeNotional >= stakeFloor.floorUsd;
  const passesCredibility = evaluatePostQueueCredibilityGate({
    tradeId: trade.tradeId,
    stakeNotional: trade.stakeNotional,
    walletAvgEv: whale?.avgEv ?? null,
    resolvedBetCount: whale?.resolvedBetsCount ?? null,
  }).passed;

  const marketTranslationGate = evaluatePostQueueMarketTranslationGate({
    tradeId: trade.tradeId,
    market: {
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
    },
    position: {
      outcome: trade.outcome,
      side: trade.side,
    },
  });
  const legacyTranslation =
    passesSource && translateMarketAndSide(toRawPolymarketTrade(trade));
  const translation =
    legacyTranslation ??
    (marketTranslationGate.translation
      ? {
          side: marketTranslationGate.translation.backingLabel,
          marketPlain: marketTranslationGate.translation.sideName,
        }
      : null);
  const passesAlignment = Boolean(
    passesSource && marketTranslationGate.passed && translation
  );

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
    stakeFloorUsd: stakeFloor.floorUsd,
    stakeFloorTier: stakeFloor.tier,
    translation: translation || undefined,
  };

  if (!passesAll) {
    matrix.primaryFailureReason = resolvePrimaryFailureReason(matrix, whale);
  }

  return matrix;
}

/**
 * Cheap deterministic gates (steps 1–3) evaluated in strict order with short-circuit.
 * Does not invoke trade EV / OpenAI. Source gate runs separately via postQueueGates.
 */
export function evaluateDeterministicPreGates(
  trade: TradePayload,
  nowMs = Date.now()
): PreGateShortCircuitResult {
  logGateCheck(trade.tradeId);

  const tradeAgeMs = nowMs - tradeTimestampMs(trade.timestamp);
  if (tradeAgeMs > MAX_TRADE_AGE_MS) {
    const ageMin = Math.round(tradeAgeMs / 60_000);
    gateLog(
      trade.tradeId,
      `[Fail: Freshness] Trade age (${ageMin}m) > ${MAX_TRADE_AGE_MS / 60_000}m threshold`
    );
    return {
      passed: false,
      reason: "STALE_TRADE",
      failedStep: "freshness",
    };
  }
  gateLog(
    trade.tradeId,
    `[Pass: Freshness] Trade age (${Math.round(tradeAgeMs / 60_000)}m) within ${MAX_TRADE_AGE_MS / 60_000}m window`
  );

  const stakeFloor = resolveTradeStakeFloor(trade);
  if (trade.stakeNotional < stakeFloor.floorUsd) {
    logStakeGate(trade, false, stakeFloor.floorUsd, stakeFloor.tier);
    return {
      passed: false,
      reason: "BELOW_STAKE_FLOOR",
      failedStep: "stake",
    };
  }
  logStakeGate(trade, true, stakeFloor.floorUsd, stakeFloor.tier);

  const marketTranslationGate = evaluatePostQueueMarketTranslationGate({
    tradeId: trade.tradeId,
    market: {
      title: trade.title,
      slug: trade.slug,
      eventSlug: trade.eventSlug,
    },
    position: {
      outcome: trade.outcome,
      side: trade.side,
    },
  });
  if (!marketTranslationGate.passed || !marketTranslationGate.translation) {
    gateLog(
      trade.tradeId,
      "[Fail: Alignment] Market position cannot be translated for feed display"
    );
    return {
      passed: false,
      reason: "ILLEGIBLE_MARKET",
      failedStep: "alignment",
    };
  }

  const legacyTranslation = translateMarketAndSide(toRawPolymarketTrade(trade));
  const translation = legacyTranslation ?? {
    side: marketTranslationGate.translation.backingLabel,
    marketPlain: marketTranslationGate.translation.sideName,
  };
  gateLog(
    trade.tradeId,
    `[Pass: Alignment] Translated to "${translation.side}" on "${translation.marketPlain}"`
  );

  return { passed: true, translation };
}

/** Step 4 — wallet credibility from registry / Polymarket history (no OpenAI). */
export function evaluateWalletCredibilityPreGate(
  trade: TradePayload,
  whale: WhaleRegistry | null | undefined
): PreGateShortCircuitResult {
  const shadowOverride = shouldApplyShadowCredibilityOverride({
    stakeNotional: trade.stakeNotional,
    resolvedBetCount: whale?.resolvedBetsCount ?? null,
    walletAvgEv: whale?.avgEv ?? null,
  });

  if (isAnonymousWalletAddress(trade.walletAddress) && !shadowOverride) {
    gateLog(
      trade.tradeId,
      `[Fail: Credibility] Anonymous wallet — resolvedBetCount=0 (< ${CREDIBILITY_CONFIG.MIN_RESOLVED_BETS})`
    );
    return {
      passed: false,
      reason: "BELOW_RESOLVED_BETS",
      failedStep: "credibility",
    };
  }

  const credibilityGate = evaluatePostQueueCredibilityGate({
    tradeId: trade.tradeId,
    stakeNotional: trade.stakeNotional,
    walletAvgEv: shadowOverride ? MIN_WALLET_AVG_EV_DECIMAL : whale?.avgEv,
    resolvedBetCount: shadowOverride
      ? MIN_WALLET_RESOLVED_BETS
      : whale?.resolvedBetsCount ?? null,
  });
  if (!credibilityGate.passed) {
    return {
      passed: false,
      reason: credibilityGate.reason ?? "BELOW_EV_THRESHOLD",
      failedStep: "credibility",
    };
  }

  if (whale) {
    gateLog(
      trade.tradeId,
      `[Pass: Wallet Credibility] Registry track record: resolvedBetCount=${whale.resolvedBetsCount} (>= ${CREDIBILITY_CONFIG.MIN_RESOLVED_BETS}), wallet avg EV (${formatWalletEvPct(whale.avgEv)}%) >= +${MIN_WALLET_AVG_EV_THRESHOLD_PCT}%`
    );
  }

  return { passed: true };
}

/** Step 6 — live trade EV gate (runs only after OpenAI / p_true pipeline). */
export function evaluateTradeEvPreGate(
  tradeEvPercent: number | null,
  tradeId?: string
): PreGateShortCircuitResult {
  const tradeEvDecimal = tradeEvPercentToDecimal(tradeEvPercent);
  const passesEv =
    tradeEvDecimal != null && tradeEvDecimal >= MIN_TRADE_EV_DECIMAL;

  if (passesEv) {
    const message = `[Pass: Trade EV] Live trade EV (${formatTradeEvPct(tradeEvPercent ?? 0)}) >= +${HIGH_EV_TRADE_THRESHOLD_PCT}% (trade.ev >= ${MIN_TRADE_EV_DECIMAL})`;
    if (tradeId) gateLog(tradeId, message);
    else console.log(message);
    return { passed: true };
  }

  const failMessage =
    tradeEvPercent == null
      ? "[Fail: Trade EV] Live trade EV unavailable"
      : `[Fail: Trade EV] Live trade EV (${formatTradeEvPct(tradeEvPercent)}) < +${HIGH_EV_TRADE_THRESHOLD_PCT}% (trade.ev < ${MIN_TRADE_EV_DECIMAL})`;
  if (tradeId) gateLog(tradeId, failMessage);
  else console.log(failMessage);

  return {
    passed: false,
    reason: "BELOW_TRADE_EV",
    failedStep: "trade_ev",
  };
}

export async function handlePreGateRejection(
  trade: TradePayload,
  result: PreGateShortCircuitResult,
  options?: TradeEligibilityOptions,
  whale?: WhaleRegistry | null
): Promise<void> {
  if (!result.reason) return;

  const metricsCollector = resolveGateMetricsCollector(options?.metrics);
  if (metricsCollector) {
    switch (result.reason) {
      case "KALSHI_PUBLIC_POSTING_DISABLED":
      case "STALE_TRADE":
      case "BELOW_STAKE_FLOOR":
      case "ILLEGIBLE_MARKET":
      case "BELOW_TRADE_EV":
      case "BELOW_RESOLVED_BETS":
      case "BELOW_EV_THRESHOLD":
      case "STAKE_TOO_LOW":
      case "LOW_EV":
        metricsCollector.recordPreGateFailure(result.reason, whale);
        break;
      default:
        break;
    }
  }

  await logGateFailure(trade, result.reason);
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
    console.warn("[x-agent/gates] x_post_log insert failed (non-fatal)", {
      tradeId: trade.tradeId,
      reason,
      error: error instanceof Error ? error.message : error,
    });
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
