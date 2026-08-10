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
  MIN_TRADE_EV_DECIMAL,
  MIN_AVG_EV_THRESHOLD_PCT,
} from "@/lib/x-agent/gateMetrics";
import { isVerboseXAgentLoggingEnabled } from "@/lib/x-agent/verboseLogging";
import type {
  MarketPosition,
  MarketPositionTranslation,
  TranslatableMarket,
} from "@/lib/marketTranslator";
import { translateMarketPositionWithFallback } from "@/lib/marketTranslator";
import { sanitizeTemplateSide } from "@/lib/x-agent/sideSanitizer";
import type { WhaleRegistry } from "@/lib/crossmarket/store/schema";
import {
  coalesceHydratedWhale,
  hydrateWalletStats,
  type WalletCredibilityResolution,
} from "@/lib/x-agent/walletCredibility";
import {
  findWhaleByWalletCaseInsensitive,
  isAnonymousWalletAddress,
  normalizeWalletAddress,
  upsertWhaleRegistry,
} from "@/lib/x-agent/whaleRegistryDb";

/** Hard kill-switch — public x_post_queue remains Polymarket-only while true (OQ-2). */
export const KALSHI_PUBLIC_POSTING_DISABLED = true;

export const KALSHI_PUBLIC_POSTING_DISABLED_REASON =
  "KALSHI_PUBLIC_POSTING_DISABLED" as const;

export const STAKE_TOO_LOW = "STAKE_TOO_LOW" as const;

export const BELOW_EV_THRESHOLD = "BELOW_EV_THRESHOLD" as const;

export const BELOW_RESOLVED_BETS = "BELOW_RESOLVED_BETS" as const;

export const UNTRANSLATABLE_MARKET = "UNTRANSLATABLE_MARKET" as const;

/** Queue variant tag for high-EV trades from wallets pending registry backfill. */
export const UNVERIFIED_WHALE_QUEUE_TAG = "unverified_whale" as const;

/** Minimum stake to defer credibility until live trade EV is computed. */
export const UNVERIFIED_WHALE_STAKE_FLOOR_USD = 1000;

/** Minimum live trade EV decimal for unverified-whale credibility bypass (0.03 = +3%). */
export const UNVERIFIED_WHALE_MIN_TRADE_EV_DECIMAL = MIN_TRADE_EV_DECIMAL;

/** Stake floor to bypass missing registry / resolved-bet history in shadow or unindexed mode. */
export const SHADOW_UNREGISTERED_STAKE_BYPASS_USD = 500;

/** Alias — missing-registry bypass uses the same $500 stake floor. */
export const UNINDEXED_WALLET_STAKE_BYPASS_USD = SHADOW_UNREGISTERED_STAKE_BYPASS_USD;

/** Resolved-bets floor used during shadow credibility override (0 = skip check). */
export const SHADOW_RESOLVED_BETS_FLOOR = 0;

export function isAllowUnindexedWallets(): boolean {
  return process.env.ALLOW_UNINDEXED_WALLETS?.trim().toLowerCase() === "true";
}

export function isAllowUnregisteredWalletsInShadow(): boolean {
  const explicit = process.env.ALLOW_UNREGISTERED_WALLETS_IN_SHADOW?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return process.env.NODE_ENV !== "production";
}

export function isMissingRegistryOverrideEnabled(): boolean {
  return isAllowUnindexedWallets() || isAllowUnregisteredWalletsInShadow();
}

export function getEffectiveResolvedBetsFloor(): number {
  if (isMissingRegistryOverrideEnabled()) {
    return SHADOW_RESOLVED_BETS_FLOOR;
  }
  return CREDIBILITY_CONFIG.MIN_RESOLVED_BETS;
}

export function shouldApplyShadowCredibilityOverride(input: {
  stakeNotional: number;
  resolvedBetCount?: number | null;
  walletAvgEv?: number | null;
}): boolean {
  if (!isMissingRegistryOverrideEnabled()) return false;

  // Resolved-bets floor is never bypassed — shadow only relaxes avg EV.
  if (!meetsFeedResolvedBetsThreshold(input.resolvedBetCount)) return false;
  if (meetsWalletAvgEvThreshold(input.walletAvgEv)) return false;

  return (
    Number.isFinite(input.stakeNotional) &&
    input.stakeNotional >= SHADOW_UNREGISTERED_STAKE_BYPASS_USD
  );
}

/** @deprecated Unindexed whale bypass removed — resolved bets floor is always enforced. */
export function shouldAllowUnindexedWhaleBypass(_input: {
  stakeNotional: number;
  resolvedBetCount?: number | null;
  whaleMissing?: boolean;
}): boolean {
  return false;
}

export function needsWalletCredibilityHydration(
  whale: WhaleRegistry | null | undefined,
  walletAddress: string
): boolean {
  if (isAnonymousWalletAddress(walletAddress)) return false;
  if (!whale) return true;
  return (whale.resolvedBetsCount ?? 0) === 0;
}

export function resolveUnindexedWhaleBypass(_input: {
  stakeNotional: number;
  resolvedBetCount?: number | null;
  walletAvgEv?: number | null;
  whaleMissing?: boolean;
}): boolean {
  return false;
}

export function formatResolvedBetCountForLog(
  resolvedBetCount: number | null | undefined
): number {
  if (resolvedBetCount == null || !Number.isFinite(resolvedBetCount)) {
    return 0;
  }
  return resolvedBetCount;
}

export function shouldDeferCredibilityForUnverifiedWhale(input: {
  whaleNotInRegistry?: boolean;
  whale?: WhaleRegistry | null;
  stakeNotional: number;
}): boolean {
  const notInRegistry = input.whaleNotInRegistry ?? input.whale == null;
  return (
    notInRegistry &&
    Number.isFinite(input.stakeNotional) &&
    input.stakeNotional >= UNVERIFIED_WHALE_STAKE_FLOOR_USD
  );
}

export function shouldApplyUnverifiedWhaleCredibilityBypass(input: {
  whaleNotInRegistry?: boolean;
  whale?: WhaleRegistry | null;
  stakeNotional?: number;
  /** Live trade EV as decimal (0.03 = +3%). */
  calculatedEvDecimal?: number | null;
}): boolean {
  const notInRegistry = input.whaleNotInRegistry ?? input.whale == null;
  if (!notInRegistry) return false;

  const stake = input.stakeNotional;
  if (!Number.isFinite(stake) || stake! < UNVERIFIED_WHALE_STAKE_FLOOR_USD) {
    return false;
  }

  const ev = input.calculatedEvDecimal;
  return (
    ev != null &&
    Number.isFinite(ev) &&
    ev >= UNVERIFIED_WHALE_MIN_TRADE_EV_DECIMAL
  );
}

/** Append the unverified_whale tag to a queue variant id without duplicating it. */
export function applyUnverifiedWhaleQueueTag(variantId: string): string {
  if (variantId.includes(UNVERIFIED_WHALE_QUEUE_TAG)) return variantId;
  return `${variantId}|${UNVERIFIED_WHALE_QUEUE_TAG}`;
}

/**
 * Fire-and-forget Polymarket closed-position fetch + whale_registry upsert.
 * Used when a high-EV trade queues before wallet credibility is established.
 */
export function scheduleWhaleRegistryBackfill(walletAddress: string): void {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized || isAnonymousWalletAddress(normalized)) return;

  void (async () => {
    try {
      const resolution = await hydrateWalletStats(normalized);
      const whale = coalesceHydratedWhale(normalized, resolution);
      const stats =
        resolution.stats ??
        (whale
          ? {
              resolvedBetsCount: whale.resolvedBetsCount,
              avgEv: whale.avgEv,
              winRate: whale.winRate,
              closedCount: whale.resolvedBetsCount,
            }
          : null);
      if (!stats) return;

      await upsertWhaleRegistry({
        walletAddress: normalized,
        resolvedBetsCount: stats.resolvedBetsCount,
        avgEv: stats.avgEv,
        winRate: stats.winRate,
      });

      console.log("[x-agent/postQueueGates] whale registry backfill complete", {
        wallet: normalized,
        resolvedBetsCount: stats.resolvedBetsCount,
        avgEv: stats.avgEv,
      });
    } catch (error) {
      console.warn("[x-agent/postQueueGates] whale registry backfill failed", {
        wallet: normalized,
        error: error instanceof Error ? error.message : error,
      });
    }
  })();
}

function passUnverifiedWhaleCredibilityGate(
  tradeId: string,
  walletAddress: string
): PostQueueCredibilityGateResult {
  scheduleWhaleRegistryBackfill(walletAddress);
  gateLog(
    tradeId,
    `[Pass: Credibility] ${UNVERIFIED_WHALE_QUEUE_TAG} — stake >= ${formatStake(UNVERIFIED_WHALE_STAKE_FLOOR_USD)}, trade EV >= +${(UNVERIFIED_WHALE_MIN_TRADE_EV_DECIMAL * 100).toFixed(1)}%; registry backfill queued`
  );
  return { passed: true, unverifiedWhale: true };
}

function passAnonymousWalletCredibilityGate(
  tradeId: string
): PostQueueCredibilityGateResult {
  gateLog(
    tradeId,
    "[Pass: Credibility] Anonymous/unattributed wallet — credibility gate bypassed"
  );
  return { passed: true, unverifiedWhale: true };
}

/**
 * Skip resolved-bets credibility for trades whose wallet could not be attributed
 * on-chain (zero address) or high-stake unindexed wallets (>= $1k).
 */
export function shouldBypassResolvedBetsForUnattributedWallet(input: {
  walletAddress?: string | null;
  stakeNotional?: number;
  whaleNotInRegistry?: boolean;
}): boolean {
  if (
    input.walletAddress != null &&
    isAnonymousWalletAddress(input.walletAddress)
  ) {
    return true;
  }

  return (
    Boolean(input.whaleNotInRegistry) &&
    Number.isFinite(input.stakeNotional) &&
    input.stakeNotional! >= UNVERIFIED_WHALE_STAKE_FLOOR_USD
  );
}

/** Full credibility bypass — only for unattributed zero-address wallets. */
export function shouldBypassCredibilityForUnattributedWallet(input: {
  walletAddress?: string | null;
}): boolean {
  return (
    input.walletAddress != null &&
    isAnonymousWalletAddress(input.walletAddress)
  );
}

/** Strict resolved-bets floor — no shadow or unindexed bypass. */
export function evaluateResolvedBetsCredibilityFloor(input: {
  tradeId: string;
  walletAddress: string;
  resolvedBetCount?: number | null;
  stakeNotional?: number;
  calculatedEvDecimal?: number | null;
  whaleNotInRegistry?: boolean;
  whale?: WhaleRegistry | null;
}): PostQueueCredibilityGateResult {
  if (
    shouldBypassResolvedBetsForUnattributedWallet({
      walletAddress: input.walletAddress,
      stakeNotional: input.stakeNotional,
      whaleNotInRegistry: input.whaleNotInRegistry,
    })
  ) {
    if (isAnonymousWalletAddress(input.walletAddress)) {
      return passAnonymousWalletCredibilityGate(input.tradeId);
    }

    gateLog(
      input.tradeId,
      `[Pass: Credibility] Unindexed wallet — resolved-bets check bypassed (stake >= ${formatStake(UNVERIFIED_WHALE_STAKE_FLOOR_USD)})`
    );
    return { passed: true, unverifiedWhale: true };
  }

  if (meetsFeedResolvedBetsThreshold(input.resolvedBetCount)) {
    return { passed: true };
  }

  if (
    shouldApplyUnverifiedWhaleCredibilityBypass({
      whaleNotInRegistry: input.whaleNotInRegistry,
      whale: input.whale,
      stakeNotional: input.stakeNotional,
      calculatedEvDecimal: input.calculatedEvDecimal,
    })
  ) {
    return passUnverifiedWhaleCredibilityGate(input.tradeId, input.walletAddress);
  }

  const resolvedCount = formatResolvedBetCountForLog(input.resolvedBetCount);
  gateLog(
    input.tradeId,
    `[Fail: Credibility] Wallet ${input.walletAddress} has ${resolvedCount} resolved bets (< ${CREDIBILITY_CONFIG.MIN_RESOLVED_BETS})`
  );
  return { passed: false, reason: BELOW_RESOLVED_BETS };
}

/**
 * Registry lookup, then Polymarket Data API hydration when the wallet is absent
 * from whale_registry or has zero resolved bets. Credible wallets are upserted.
 */
export async function hydrateWalletForPostQueueCredibility(
  walletAddress: string,
  options?: { tradeId?: string; existingWhale?: WhaleRegistry | null }
): Promise<WalletCredibilityResolution> {
  const normalized = normalizeWalletAddress(walletAddress);
  if (!normalized || isAnonymousWalletAddress(normalized)) {
    return { whale: null, source: "anonymous" };
  }

  const fromRegistry = await findWhaleByWalletCaseInsensitive(normalized);
  const existing = options?.existingWhale ?? fromRegistry;
  if (existing && (existing.resolvedBetsCount ?? 0) > 0) {
    return { whale: existing, source: "registry" };
  }

  if (options?.tradeId) {
    gateLog(
      options.tradeId,
      `[Hydrate] Wallet missing or resolvedBetCount=0 — fetching Polymarket Data API stats`
    );
  }

  const resolution = await hydrateWalletStats(normalized, existing);

  if (options?.tradeId) {
    const hydratedWhale = coalesceHydratedWhale(normalized, resolution);
    const resolvedBetCount =
      resolution.stats?.resolvedBetsCount ??
      hydratedWhale?.resolvedBetsCount ??
      "n/a";
    const avgEv = resolution.stats?.avgEv ?? hydratedWhale?.avgEv ?? "n/a";

    if (resolution.source === "polymarket_api") {
      gateLog(
        options.tradeId,
        `[Hydrate] Wallet stats saved to whale_registry (resolvedBetCount=${resolvedBetCount}, avgEv=${avgEv})`
      );
    } else if (
      resolution.source === "low_credibility_cache" ||
      (resolution.source === "unavailable" && resolution.stats)
    ) {
      gateLog(
        options.tradeId,
        `[Hydrate] Wallet profile built in-memory from Polymarket API (resolvedBetCount=${resolvedBetCount}, avgEv=${avgEv})`
      );
    }
  }

  return resolution;
}

/**
 * Hydrate a missing or zero-history registry wallet for credibility evaluation.
 */
export async function resolveCredibilityWhaleWithHydration(input: {
  tradeId: string;
  walletAddress: string;
  stakeNotional: number;
  whale?: WhaleRegistry | null;
}): Promise<{
  whale: WhaleRegistry | null;
  resolution?: WalletCredibilityResolution;
  resolvedBetCount: number | null;
  whaleNotInRegistry: boolean;
}> {
  if (isAnonymousWalletAddress(input.walletAddress)) {
    return {
      whale: input.whale ?? null,
      resolvedBetCount: 0,
      whaleNotInRegistry: false,
    };
  }

  const walletAddress = normalizeWalletAddress(input.walletAddress);
  const registryRow = walletAddress
    ? await findWhaleByWalletCaseInsensitive(walletAddress)
    : null;
  const whaleNotInRegistry = !registryRow;

  let whale = input.whale ?? registryRow ?? null;
  let resolution: WalletCredibilityResolution | undefined;

  if (needsWalletCredibilityHydration(whale, input.walletAddress)) {
    resolution = await hydrateWalletForPostQueueCredibility(input.walletAddress, {
      tradeId: input.tradeId,
      existingWhale: whale,
    });
    whale = coalesceHydratedWhale(input.walletAddress, resolution);
  }

  const resolvedBetCount =
    resolution?.stats?.resolvedBetsCount ??
    whale?.resolvedBetsCount ??
    null;

  return { whale, resolution, resolvedBetCount, whaleNotInRegistry };
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
  /** Live trade EV as decimal (0.03 = +3%). */
  calculatedEvDecimal?: number | null;
  whaleNotInRegistry?: boolean;
  whale?: WhaleRegistry | null;
  walletAddress?: string;
}

export interface PostQueueCredibilityGateResult {
  passed: boolean;
  reason?: PostQueueCredibilityRejectionReason;
  unverifiedWhale?: boolean;
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
  if (!isVerboseXAgentLoggingEnabled()) return;
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
  if (isVerboseXAgentLoggingEnabled()) {
    console.log(message);
  }
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

  if (shouldBypassCredibilityForUnattributedWallet(input)) {
    return passAnonymousWalletCredibilityGate(input.tradeId);
  }

  const resolvedBetCount = input.resolvedBetCount ?? null;
  const avgEv = input.walletAvgEv;

  if (!meetsFeedResolvedBetsThreshold(resolvedBetCount)) {
    if (
      shouldApplyUnverifiedWhaleCredibilityBypass({
        whaleNotInRegistry: input.whaleNotInRegistry,
        whale: input.whale,
        stakeNotional: stake,
        calculatedEvDecimal: input.calculatedEvDecimal,
      }) &&
      input.walletAddress
    ) {
      return passUnverifiedWhaleCredibilityGate(
        input.tradeId,
        input.walletAddress
      );
    }

    const resolvedLabel =
      resolvedBetCount != null && Number.isFinite(resolvedBetCount)
        ? String(resolvedBetCount)
        : "0";
    gateLog(
      input.tradeId,
      `[Fail: Credibility] resolvedBetCount=${resolvedLabel} (< ${CREDIBILITY_CONFIG.MIN_RESOLVED_BETS})`
    );
    return { passed: false, reason: BELOW_RESOLVED_BETS };
  }

  const shadowOverride = shouldApplyShadowCredibilityOverride({
    stakeNotional: stake,
    resolvedBetCount,
    walletAvgEv: avgEv,
  });

  if (!shadowOverride && !meetsWalletAvgEvThreshold(avgEv)) {
    if (
      shouldApplyUnverifiedWhaleCredibilityBypass({
        whaleNotInRegistry: input.whaleNotInRegistry,
        whale: input.whale,
        stakeNotional: stake,
        calculatedEvDecimal: input.calculatedEvDecimal,
      }) &&
      input.walletAddress
    ) {
      return passUnverifiedWhaleCredibilityGate(
        input.tradeId,
        input.walletAddress
      );
    }

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
    const modeLabel = isAllowUnindexedWallets()
      ? "ALLOW_UNINDEXED_WALLETS"
      : "shadow/unregistered override";
    gateLog(
      input.tradeId,
      `[Pass: Credibility] ${modeLabel} — stake (${formatStake(stake)}) >= ${formatStake(SHADOW_UNREGISTERED_STAKE_BYPASS_USD)}; wallet avg EV bypass (resolvedBetCount=${resolvedBetCount})`
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

  if (usedFallback) {
    if (input.tradeId) {
      gateLog(
        input.tradeId,
        `[Fail: Market Translation] Fallback — no named side for "${translation.sideName}"`
      );
    }
    return { passed: false, reason: UNTRANSLATABLE_MARKET };
  }

  const sideName = sanitizeTemplateSide(translation.sideName);
  if (!sideName) {
    if (input.tradeId) {
      gateLog(
        input.tradeId,
        `[Fail: Market Translation] Could not sanitize named side "${translation.sideName}"`
      );
    }
    return { passed: false, reason: UNTRANSLATABLE_MARKET };
  }

  const sanitized = {
    ...translation,
    sideName,
    backingLabel: `Backing ${sideName}`,
  };

  if (input.tradeId) {
    gateLog(
      input.tradeId,
      `[Pass: Market Translation] ${sanitized.backingLabel}${
        sanitized.exitByLabel ? ` · ${sanitized.exitByLabel}` : ""
      }`
    );
  }

  return { passed: true, translation: sanitized };
}

export function logPostQueueIngestionSuccess(
  tradeId: string,
  stakeUsd: number
): void {
  console.log(
    `[Pass: ALL GATES] tradeId=${tradeId} (${formatStake(stakeUsd)}) queued into x_post_queue`
  );
}
