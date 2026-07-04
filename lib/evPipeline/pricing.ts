import type { EvPlatform } from "@/lib/finance/evEngine";
import {
  normalizeKalshiTicker,
  normalizePmTokenId,
  pipelineMappingPairKey,
} from "@/lib/evPipeline/crossAssetLookup";
import {
  computeTradeEvDisplay,
} from "@/lib/evPipeline/computeTradeEv";
import { resolvePTrueSync } from "@/lib/evPipeline/pTrueEnsembleResolver";
import type { PricingMode } from "@/lib/evPipeline/pTrueTypes";
import type { CachedOrderBookMid } from "@/lib/evPipeline/redisCache";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { normalizeIncomingTradePrice } from "@/lib/evPipeline/tradeEvRecord";

export type { PricingMode } from "@/lib/evPipeline/pTrueTypes";

export interface TradeEvPricingInput {
  mappingPairKey: string | null;
  platform: EvPlatform;
  pmOb?: CachedOrderBookMid | null;
  kalshiOb?: CachedOrderBookMid | null;
  pmMid?: number | null;
  kalshiMid?: number | null;
  /** Sportsbook consensus mid when Kalshi pair is missing. */
  exchangeMid?: number | null;
  executionPrice?: number | null;
  tokenId?: string | null;
  kalshiTicker?: string | null;
  lookupKey: string;
  /** Ensemble p_true from calculatePTrue / true_probabilities when OB mids are incomplete. */
  ensemblePTrue?: number | null;
  /** Last-known fair-value baseline (mapping cache / true_probabilities) when ensemble is not inlined. */
  baselinePTrue?: number | null;
  /** Cross-venue prior used when only one resting mid is available. */
  marketPrior?: number | null;
}

export interface TradeEvPricingResult {
  pTrue: number;
  pMarket: number;
  netEvPercent: number;
  netEv: number;
  grossEv: number;
  grossEvPercent: number;
  pmMid: number | null;
  kalshiMid: number | null;
  pricingMode: PricingMode;
  pTrueSource?: import("@/lib/evPipeline/pTrueTypes").PTrueSource;
  pTrueConfidence?: number;
  pTrueLowConfidence?: boolean;
  evFormulaVersion?: string;
}

/** Resting touch mid from a cached order-book snapshot. */
export function restingMidFromOrderBook(
  ob: CachedOrderBookMid | null | undefined
): number | null {
  if (!ob) return null;
  if (
    ob.bid != null &&
    ob.ask != null &&
    ob.bid > 0 &&
    ob.ask > 0 &&
    ob.bid < ob.ask
  ) {
    return (ob.bid + ob.ask) / 2;
  }
  return Number.isFinite(ob.mid) ? ob.mid : null;
}

/** Inverse-spread weight — tighter books get more influence in the cross-venue blend. */
export function venueLiquidityWeight(
  ob: CachedOrderBookMid | null | undefined
): number {
  const mid = restingMidFromOrderBook(ob);
  if (mid == null) return 0;
  const spread =
    ob?.bid != null && ob?.ask != null
      ? Math.max(ob.ask - ob.bid, 0.001)
      : 0.05;
  return mid * (1 / spread);
}

/**
 * Liquidity-weighted blend of PM + Kalshi resting mids (paired mappings).
 */
export function liquidityWeightedCrossMid(
  pmOb: CachedOrderBookMid | null | undefined,
  kalshiOb: CachedOrderBookMid | null | undefined,
  pmMidFallback: number | null = null,
  kalshiMidFallback: number | null = null
): number | null {
  const pmResting = restingMidFromOrderBook(pmOb) ?? pmMidFallback;
  const kalshiResting = restingMidFromOrderBook(kalshiOb) ?? kalshiMidFallback;

  if (pmResting == null && kalshiResting == null) return null;
  if (pmResting == null) return kalshiResting;
  if (kalshiResting == null) return pmResting;

  const wPm = venueLiquidityWeight(pmOb) || pmResting;
  const wKx = venueLiquidityWeight(kalshiOb) || kalshiResting;
  return (pmResting * wPm + kalshiResting * wKx) / (wPm + wKx);
}

function platformRestingMid(
  platform: EvPlatform,
  pmResting: number | null,
  kalshiResting: number | null
): number | null {
  return platform === "polymarket" ? pmResting : kalshiResting;
}

function isFiniteProb(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

export function resolveMarketPrior(
  pmMid: number | null,
  kalshiMid: number | null,
  explicit?: number | null
): number {
  if (isFiniteProb(explicit)) return explicit;
  if (pmMid != null && kalshiMid != null) return (pmMid + kalshiMid) / 2;
  if (pmMid != null) return pmMid;
  if (kalshiMid != null) return kalshiMid;
  return 0.5;
}

const PROB_COMPARE_EPS = 1e-6;

/** Resting mid on the trade's venue, or whichever single leg is available for paired markets. */
export function resolveSingleVenueMid(
  platform: EvPlatform,
  priced: { pmMid: number | null; kalshiMid: number | null },
  platformMid: number | null
): number | null {
  return platformMid ?? priced.pmMid ?? priced.kalshiMid ?? null;
}

function resolveEnsembleFromInput(input: {
  ensemblePTrue?: number | null;
  baselinePTrue?: number | null;
}): number | null {
  if (isFiniteProb(input.ensemblePTrue)) return input.ensemblePTrue;
  if (isFiniteProb(input.baselinePTrue)) return input.baselinePTrue;
  return null;
}

function isIdentityTrap(
  pricedPTrue: number,
  singleVenueMid: number | null
): boolean {
  return (
    singleVenueMid != null &&
    Math.abs(pricedPTrue - singleVenueMid) <= PROB_COMPARE_EPS
  );
}

/**
 * Fair-value baseline for directional EV across all pricing modes.
 * Prefers ensemble/cache inputs, then non-touch priced.pTrue, then exchange mid.
 */
export function resolveFairValueBaseline(
  input: Pick<
    TradeEvPricingInput,
    "ensemblePTrue" | "baselinePTrue" | "exchangeMid"
  >,
  priced: {
    pTrue: number;
    pmMid: number | null;
    kalshiMid: number | null;
  },
  singleVenueMid: number | null
): number | null {
  const ensemble = resolveEnsembleFromInput(input);
  if (ensemble != null) return ensemble;

  const identityTrap =
    isFiniteProb(priced.pTrue) && isIdentityTrap(priced.pTrue, singleVenueMid);

  if (!identityTrap && isFiniteProb(priced.pTrue)) {
    if (singleVenueMid == null) return priced.pTrue;
    if (Math.abs(priced.pTrue - singleVenueMid) > PROB_COMPARE_EPS) {
      return priced.pTrue;
    }
  }

  if (input.exchangeMid != null && Number.isFinite(input.exchangeMid)) {
    return input.exchangeMid;
  }

  if (singleVenueMid == null && isFiniteProb(priced.pTrue)) {
    return priced.pTrue;
  }

  return null;
}

/**
 * Directional edge: fair baseline minus the available venue mid (or market prior).
 */
export function computeDirectionalNetEvPercent(
  fairBaseline: number,
  venueMid: number | null,
  marketPrior: number
): number {
  const referenceMarket = venueMid ?? marketPrior;
  const breakdown = computeTradeEvDisplay({
    pTrue: fairBaseline,
    pMarketFallback: referenceMarket,
    platform: "polymarket",
  });
  return breakdown.netEvPercent;
}

/**
 * EV vs the best available reference price when paired OB data is partial.
 * Prefers the trade venue mid, then the cross-venue prior.
 */
export function computeEnsembleBackedNetEvPercent(
  ensemblePTrue: number,
  platformMid: number | null,
  marketPrior: number
): number {
  return computeDirectionalNetEvPercent(ensemblePTrue, platformMid, marketPrior);
}

/**
 * Hierarchical p_true resolver — delegates to the ensemble resolver (never null).
 */
export function computePricingPTrue(input: {
  mappingPairKey: string | null;
  platform: EvPlatform;
  pmOb?: CachedOrderBookMid | null;
  kalshiOb?: CachedOrderBookMid | null;
  pmMid?: number | null;
  kalshiMid?: number | null;
  exchangeMid?: number | null;
  ensemblePTrue?: number | null;
  baselinePTrue?: number | null;
  executionPrice?: number | null;
  marketPrior?: number | null;
}): {
  pTrue: number;
  pmMid: number | null;
  kalshiMid: number | null;
  pricingMode: PricingMode;
  pTrueSource: import("@/lib/evPipeline/pTrueTypes").PTrueSource;
  pTrueConfidence: number;
} {
  const resolved = resolvePTrueSync({
    mappingPairKey: input.mappingPairKey,
    platform: input.platform,
    pmOb: input.pmOb,
    kalshiOb: input.kalshiOb,
    pmMid: input.pmMid,
    kalshiMid: input.kalshiMid,
    exchangeMid: input.exchangeMid,
    ensemblePTrue: input.ensemblePTrue,
    baselinePTrue: input.baselinePTrue,
    executionPrice: input.executionPrice,
    marketPrior: input.marketPrior,
  });

  return {
    pTrue: resolved.pTrue,
    pmMid: resolved.pmMid,
    kalshiMid: resolved.kalshiMid,
    pricingMode: resolved.pricingMode,
    pTrueSource: resolved.source,
    pTrueConfidence: resolved.confidence,
  };
}

/** Unified EV display percent via canonical binary_true_ev_v1 formula. */
export function computeNetEvPercentFromExecution(
  pTrue: number,
  executionPrice: number,
  platform: EvPlatform = "polymarket"
): number {
  return computeTradeEvDisplay({
    pTrue,
    executionPrice,
    platform,
  }).netEvPercent;
}

/**
 * Full trade EV pricing — always returns a result via the ensemble resolver.
 */
export function computeTradeEvPricing(
  input: TradeEvPricingInput
): TradeEvPricingResult {
  const executionPrice = normalizeIncomingTradePrice(input.executionPrice) ?? null;
  const tokenId = normalizePmTokenId(input.tokenId);
  const kalshiTicker = normalizeKalshiTicker(input.kalshiTicker);
  const mappingPairKey =
    input.mappingPairKey ??
    (tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : null);

  const pTrueResult = resolvePTrueSync({
    mappingPairKey,
    platform: input.platform,
    pmOb: input.pmOb,
    kalshiOb: input.kalshiOb,
    pmMid: input.pmMid,
    kalshiMid: input.kalshiMid,
    exchangeMid: input.exchangeMid,
    ensemblePTrue: input.ensemblePTrue,
    baselinePTrue: input.baselinePTrue,
    executionPrice: input.executionPrice,
    marketPrior: input.marketPrior,
  });

  const platformMid = platformRestingMid(
    input.platform,
    pTrueResult.pmMid,
    pTrueResult.kalshiMid
  );

  const evDisplay = computeTradeEvDisplay({
    pTrue: pTrueResult.pTrue,
    executionPrice,
    platform: input.platform,
    pMarketFallback: platformMid ?? pTrueResult.marketPrior,
  });

  return {
    pTrue: pTrueResult.pTrue,
    pMarket: evDisplay.pMarket,
    netEvPercent: evDisplay.netEvPercent,
    netEv: evDisplay.netEv,
    grossEv: evDisplay.grossEv,
    grossEvPercent: evDisplay.grossEvPercent,
    pmMid: pTrueResult.pmMid,
    kalshiMid: pTrueResult.kalshiMid,
    pricingMode: pTrueResult.pricingMode,
    pTrueSource: pTrueResult.source,
    pTrueConfidence: pTrueResult.confidence,
    pTrueLowConfidence: pTrueResult.lowConfidence,
    evFormulaVersion: evDisplay.formula,
  };
}

export function buildPipelineTradeEvFromPricing(
  input: TradeEvPricingInput
): PipelineTradeEv {
  const pricing = computeTradeEvPricing(input);

  const tokenId = normalizePmTokenId(input.tokenId);
  const kalshiTicker = normalizeKalshiTicker(input.kalshiTicker);
  const mappingPairKey =
    input.mappingPairKey ??
    (tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : null);

  return {
    key: input.lookupKey,
    status: "ok",
    tokenId,
    kalshiTicker,
    mappingPairKey,
    pTrue: pricing.pTrue,
    pMarket: pricing.pMarket,
    pmMid: pricing.pmMid,
    kalshiMid: pricing.kalshiMid,
    netEv: pricing.netEv,
    grossEv: pricing.grossEv,
    netEvPercent: pricing.netEvPercent,
    grossEvPercent: pricing.grossEvPercent,
    averageEv: pricing.netEvPercent,
    pTrueSource: pricing.pTrueSource,
    pTrueConfidence: pricing.pTrueConfidence,
    pTrueLowConfidence: pricing.pTrueLowConfidence,
    evFormulaVersion: pricing.evFormulaVersion,
  };
}

/** Re-apply execution-aware pricing to an existing cached payload. */
export function applyExecutionPricingToTradeEv(
  record: PipelineTradeEv,
  input: Omit<TradeEvPricingInput, "lookupKey"> & { lookupKey?: string }
): PipelineTradeEv {
  const lookupKey = input.lookupKey ?? record.key;
  const tokenId = normalizePmTokenId(input.tokenId ?? record.tokenId);
  const kalshiTicker = normalizeKalshiTicker(
    input.kalshiTicker ?? record.kalshiTicker
  );
  const mappingPairKey =
    record.mappingPairKey ??
    (tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : null);

  const priced = computeTradeEvPricing({
    lookupKey,
    mappingPairKey,
    platform: input.platform,
    pmOb: input.pmOb,
    kalshiOb: input.kalshiOb,
    pmMid: input.pmMid ?? record.pmMid ?? null,
    kalshiMid: input.kalshiMid ?? record.kalshiMid ?? null,
    exchangeMid: input.exchangeMid,
    executionPrice: input.executionPrice,
    tokenId,
    kalshiTicker,
    ensemblePTrue: input.ensemblePTrue ?? record.pTrue ?? null,
    baselinePTrue: input.baselinePTrue ?? record.pTrue ?? null,
    marketPrior: input.marketPrior,
  });

  return {
    ...record,
    key: lookupKey,
    status: "ok",
    tokenId,
    kalshiTicker,
    mappingPairKey,
    pTrue: priced.pTrue,
    pMarket: priced.pMarket,
    pmMid: priced.pmMid,
    kalshiMid: priced.kalshiMid,
    netEv: priced.netEv,
    grossEv: priced.grossEv,
    netEvPercent: priced.netEvPercent,
    grossEvPercent: priced.grossEvPercent,
    averageEv: priced.netEvPercent,
    pTrueSource: priced.pTrueSource,
    pTrueConfidence: priced.pTrueConfidence,
    pTrueLowConfidence: priced.pTrueLowConfidence,
    evFormulaVersion: priced.evFormulaVersion,
  };
}
