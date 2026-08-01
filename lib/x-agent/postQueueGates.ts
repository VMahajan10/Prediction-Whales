/**
 * Post-queue gates — source eligibility and wallet credibility thresholds
 * before template generation and x_post_queue insertion.
 */

import {
  CREDIBILITY_CONFIG,
  meetsFeedResolvedBetsThreshold,
  meetsWalletAvgEvThreshold,
} from "@/lib/feedQualification";
import {
  MIN_AVG_EV_THRESHOLD_PCT,
} from "@/lib/x-agent/gateMetrics";
import type {
  MarketPosition,
  MarketPositionTranslation,
  TranslatableMarket,
} from "@/lib/marketTranslator";
import { translateMarketPositionWithFallback } from "@/lib/marketTranslator";
import {
  findWhaleByWalletCaseInsensitive,
  isAnonymousWalletAddress,
  normalizeWalletAddress,
} from "@/lib/x-agent/whaleRegistryDb";
import {
  resolveWhaleForCredibilityGate,
  type WalletCredibilityResolution,
} from "@/lib/x-agent/walletCredibility";

/** Hard kill-switch — public x_post_queue remains Polymarket-only while true (OQ-2). */
export const KALSHI_PUBLIC_POSTING_DISABLED = true;

export const KALSHI_PUBLIC_POSTING_DISABLED_REASON =
  "KALSHI_PUBLIC_POSTING_DISABLED" as const;

export const STAKE_TOO_LOW = "STAKE_TOO_LOW" as const;

export const BELOW_EV_THRESHOLD = "BELOW_EV_THRESHOLD" as const;

export const BELOW_RESOLVED_BETS = "BELOW_RESOLVED_BETS" as const;

export const UNTRANSLATABLE_MARKET = "UNTRANSLATABLE_MARKET" as const;

/** Shadow-mode stake floor to bypass missing registry / resolved-bet history. */
export const SHADOW_UNREGISTERED_STAKE_BYPASS_USD = 250;

/** Resolved-bets floor used during shadow credibility override (0 = skip check). */
export const SHADOW_RESOLVED_BETS_FLOOR = 0;

export function getEffectiveResolvedBetsFloor(): number {
  if (isAllowUnregisteredWalletsInShadow()) {
    return SHADOW_RESOLVED_BETS_FLOOR;
  }
  return CREDIBILITY_CONFIG.MIN_RESOLVED_BETS;
}

export function isAllowUnregisteredWalletsInShadow(): boolean {
  const explicit = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return process.env.NODE_ENV !== "production";
}

export function shouldApplyShadowCredibilityOverride(input: {
  stakeNotional: number;
  resolvedBetCount?: number | null;
  walletAvgEv?: number | null;
}): boolean {
  if (!isAllowUnregisteredWalletsInShadow()) return false;

  const hasResolvedBets = meetsFeedResolvedBetsThreshold(input.resolvedBetCount);
  const hasAvgEv = meetsWalletAvgEvThreshold(input.walletAvgEv);
  if (hasResolvedBets && hasAvgEv) return false;

  return (
    Number.isFinite(input.stakeNotional) &&
    input.stakeNotional >= SHADOW_UNREGISTERED_STAKE_BYPASS_USD
  );
}

/**
 * Registry lookup, then Polymarket Data API hydration when the wallet is absent
 * from whale_registry.
 */
export async function hydrateWalletForPostQueueCredibility(
  walletAddress: string
): Promise<WalletCredibilityResolution> {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized || isAnonymousWalletAddress(normalized)) {
    return { whale: null, source: "anonymous" };
  }

  const fromRegistry = await findWhaleByWalletCaseInsensitive(normalized);
  if (fromRegistry) {
    return { whale: fromRegistry, source: "registry" };
  }

  return resolveWhaleForCredibilityGate(normalized);
}

export type PostQueueSourceRejectionReason =
  typeof KALSHI_PUBLIC_POSTING_DISABLED_REASON;

export type PostQueueCredibilityRejectionReason =
  | typeof STAKE_TOO_LOW
  | typeof BELOW_EV_THRESHOLD
  | typeof BELOW_RESOLVED_BETS;

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
  resolvedBetCount?: number | null;
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
  if (!Number.isFinite(stake) || stake < CREDIBILITY_CONFIG.MIN_STAKE_USD) {
    gateLog(
      input.tradeId,
      `[Fail: Credibility] Stake (${formatStake(stake)}) < ${formatStake(CREDIBILITY_CONFIG.MIN_STAKE_USD)} threshold`
    );
    return { passed: false, reason: STAKE_TOO_LOW };
  }

  const resolvedBetCount = input.resolvedBetCount ?? null;
  const avgEv = input.walletAvgEv;
  const shadowOverride = shouldApplyShadowCredibilityOverride({
    stakeNotional: stake,
    resolvedBetCount,
    walletAvgEv: avgEv,
  });

  if (
    !shadowOverride &&
    !meetsFeedResolvedBetsThreshold(resolvedBetCount)
  ) {
    const resolvedLabel =
      resolvedBetCount != null && Number.isFinite(resolvedBetCount)
        ? String(resolvedBetCount)
        : "N/A";
    gateLog(
      input.tradeId,
      `[Fail: Credibility] resolvedBetCount=${resolvedLabel} (< ${CREDIBILITY_CONFIG.MIN_RESOLVED_BETS})`
    );
    return { passed: false, reason: BELOW_RESOLVED_BETS };
  }

  if (!shadowOverride && !meetsWalletAvgEvThreshold(avgEv)) {
    const avgEvPct =
      avgEv != null && Number.isFinite(avgEv)
        ? (avgEv * 100).toFixed(1)
        : "N/A";
    gateLog(
      input.tradeId,
      `[Fail: Credibility] resolvedBetCount=${resolvedBetCount}, wallet avg EV (${avgEvPct}%) < +${MIN_AVG_EV_THRESHOLD_PCT.toFixed(1)}% threshold`
    );
    return { passed: false, reason: BELOW_EV_THRESHOLD };
  }

  if (shadowOverride) {
    gateLog(
      input.tradeId,
      `[Pass: Credibility] Shadow override — stake (${formatStake(stake)}) >= ${formatStake(SHADOW_UNREGISTERED_STAKE_BYPASS_USD)}; skipping registry checks (resolved bets floor=${SHADOW_RESOLVED_BETS_FLOOR})`
    );
    return { passed: true };
  }

  gateLog(
    input.tradeId,
    `[Pass: Credibility] Stake (${formatStake(stake)}) >= ${formatStake(CREDIBILITY_CONFIG.MIN_STAKE_USD)}, resolvedBetCount=${resolvedBetCount} >= ${CREDIBILITY_CONFIG.MIN_RESOLVED_BETS}, wallet avg EV (${(avgEv! * 100).toFixed(1)}%) >= +${MIN_AVG_EV_THRESHOLD_PCT.toFixed(1)}%`
  );

  return { passed: true };
}

/**
 * Market position translation gate — uses title/outcome fallback when custom
 * mapping cannot express the position without raw YES/NO tokens.
 */
export function evaluatePostQueueMarketTranslationGate(
  input: PostQueueMarketTranslationGateInput
): PostQueueMarketTranslationGateResult {
  const { translation, usedFallback } = translateMarketPositionWithFallback(
    input.market,
    input.position
  );

  if (input.tradeId) {
    if (usedFallback) {
      gateLog(
        input.tradeId,
        `[Pass: Market Translation] Fallback — ${translation.backingLabel} on "${translation.sideName}"`
      );
    } else {
      gateLog(
        input.tradeId,
        `[Pass: Market Translation] ${translation.backingLabel}${
          translation.exitByLabel ? ` · ${translation.exitByLabel}` : ""
        }`
      );
    }
  }

  return { passed: true, translation };
}

export function logPostQueueIngestionSuccess(
  tradeId: string,
  queueId: string
): void {
  gateLog(
    tradeId,
    `[Pass: All Gates] Trade queued for review — x_post_queue id=${queueId} status=PENDING_REVIEW`
  );
}
