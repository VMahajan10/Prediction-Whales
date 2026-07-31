/**
 * Post-queue gates — source eligibility and wallet credibility thresholds
 * before template generation and x_post_queue insertion.
 */

import {
  MIN_AVG_EV_THRESHOLD,
  MIN_AVG_EV_THRESHOLD_PCT,
  MIN_STAKE_THRESHOLD,
} from "@/lib/x-agent/gateMetrics";
import type {
  MarketPosition,
  MarketPositionTranslation,
  TranslatableMarket,
} from "@/lib/marketTranslator";
import { translateMarketPosition } from "@/lib/marketTranslator";

/** Hard kill-switch — public x_post_queue remains Polymarket-only while true (OQ-2). */
export const KALSHI_PUBLIC_POSTING_DISABLED = true;

export const KALSHI_PUBLIC_POSTING_DISABLED_REASON =
  "KALSHI_PUBLIC_POSTING_DISABLED" as const;

export const STAKE_TOO_LOW = "STAKE_TOO_LOW" as const;

export const BELOW_EV_THRESHOLD = "BELOW_EV_THRESHOLD" as const;

export const UNTRANSLATABLE_MARKET = "UNTRANSLATABLE_MARKET" as const;

export type PostQueueSourceRejectionReason =
  typeof KALSHI_PUBLIC_POSTING_DISABLED_REASON;

export type PostQueueCredibilityRejectionReason =
  | typeof STAKE_TOO_LOW
  | typeof BELOW_EV_THRESHOLD;

export interface PostQueueSourceGateInput {
  source: "polymarket" | "kalshi";
  tradeId?: string;
}

export interface PostQueueSourceGateResult {
  passed: boolean;
  reason?: PostQueueSourceRejectionReason;
}

export interface PostQueueCredibilityGateInput {
  tradeId: string;
  stakeNotional: number;
  walletAvgEv?: number | null;
}

export interface PostQueueCredibilityGateResult {
  passed: boolean;
  reason?: PostQueueCredibilityRejectionReason;
}

export interface PostQueueMarketTranslationGateInput {
  tradeId?: string;
  market: TranslatableMarket;
  position: MarketPosition;
}

export interface PostQueueMarketTranslationGateResult {
  passed: boolean;
  reason?: typeof UNTRANSLATABLE_MARKET;
  translation?: MarketPositionTranslation;
}

function gateLog(tradeId: string, message: string): void {
  console.log(`[Gate] tradeId=${tradeId} ${message}`);
}

function formatStake(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

export function logPostQueueSourceSkip(tradeId?: string): void {
  const message =
    "[Fail: Source] Kalshi public posting disabled (Polymarket required)";
  if (tradeId) {
    gateLog(tradeId, message);
    return;
  }
  console.log(message);
}

/** Returns true only for Polymarket-sourced trades when Kalshi posting is disabled. */
export function isPostQueueSourceAllowed(
  source: "polymarket" | "kalshi"
): boolean {
  if (KALSHI_PUBLIC_POSTING_DISABLED && source === "kalshi") return false;
  return source === "polymarket";
}

/**
 * Step 0 — post-queue source gate. Kalshi trades short-circuit with
 * KALSHI_PUBLIC_POSTING_DISABLED before template generation or queuing.
 */
export function evaluatePostQueueSourceGate(
  input: PostQueueSourceGateInput
): PostQueueSourceGateResult {
  if (!isPostQueueSourceAllowed(input.source)) {
    logPostQueueSourceSkip(input.tradeId);
    return { passed: false, reason: KALSHI_PUBLIC_POSTING_DISABLED_REASON };
  }

  if (input.tradeId) {
    gateLog(input.tradeId, "[Pass: Source] Polymarket trade");
  }

  return { passed: true };
}

/**
 * Credibility gate — minimum stake and wallet avg EV before queueing or
 * rendering in qualified feeds.
 */
export function evaluatePostQueueCredibilityGate(
  input: PostQueueCredibilityGateInput
): PostQueueCredibilityGateResult {
  const stake = input.stakeNotional;
  if (!Number.isFinite(stake) || stake < MIN_STAKE_THRESHOLD) {
    gateLog(
      input.tradeId,
      `[Fail: Credibility] Stake (${formatStake(stake)}) < ${formatStake(MIN_STAKE_THRESHOLD)} threshold`
    );
    return { passed: false, reason: STAKE_TOO_LOW };
  }

  const avgEv = input.walletAvgEv;
  if (avgEv == null || !Number.isFinite(avgEv) || avgEv < MIN_AVG_EV_THRESHOLD) {
    const avgEvPct =
      avgEv != null && Number.isFinite(avgEv)
        ? (avgEv * 100).toFixed(1)
        : "N/A";
    gateLog(
      input.tradeId,
      `[Fail: Credibility] Wallet avg EV (${avgEvPct}%) < +${MIN_AVG_EV_THRESHOLD_PCT.toFixed(1)}% threshold`
    );
    return { passed: false, reason: BELOW_EV_THRESHOLD };
  }

  gateLog(
    input.tradeId,
    `[Pass: Credibility] Stake (${formatStake(stake)}) >= ${formatStake(MIN_STAKE_THRESHOLD)}, wallet avg EV (${(avgEv * 100).toFixed(1)}%) >= +${MIN_AVG_EV_THRESHOLD_PCT.toFixed(1)}%`
  );

  return { passed: true };
}

/**
 * Market position translation gate — rejects trades that cannot be rendered
 * without raw YES/NO copy.
 */
export function evaluatePostQueueMarketTranslationGate(
  input: PostQueueMarketTranslationGateInput
): PostQueueMarketTranslationGateResult {
  const translation = translateMarketPosition(input.market, input.position);
  if (!translation) {
    if (input.tradeId) {
      gateLog(
        input.tradeId,
        "[Fail: Market Translation] Position is untranslatable for feed display"
      );
    }
    return { passed: false, reason: UNTRANSLATABLE_MARKET };
  }

  if (input.tradeId) {
    gateLog(
      input.tradeId,
      `[Pass: Market Translation] ${translation.backingLabel}${
        translation.exitByLabel ? ` · ${translation.exitByLabel}` : ""
      }`
    );
  }

  return { passed: true, translation };
}
