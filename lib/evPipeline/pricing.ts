import type { EvPlatform } from "@/lib/finance/evEngine";
import {
  normalizeKalshiTicker,
  normalizePmTokenId,
  pipelineMappingPairKey,
} from "@/lib/evPipeline/crossAssetLookup";
import type { CachedOrderBookMid } from "@/lib/evPipeline/redisCache";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  normalizeIncomingTradePrice,
  sanitizeEvPercent,
  toEvDisplayPercent,
} from "@/lib/evPipeline/tradeEvRecord";

export type PricingMode = "paired_cross" | "standalone_resting";

export interface TradeEvPricingInput {
  mappingPairKey: string | null;
  platform: EvPlatform;
  pmOb?: CachedOrderBookMid | null;
  kalshiOb?: CachedOrderBookMid | null;
  pmMid?: number | null;
  kalshiMid?: number | null;
  executionPrice?: number | null;
  tokenId?: string | null;
  kalshiTicker?: string | null;
  lookupKey: string;
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

/**
 * Hierarchical p_true resolver:
 * 1. Paired (mappingPairKey) → liquidity-weighted cross-venue mid
 * 2. Standalone → resting mid on the trade's venue
 */
export function computePricingPTrue(input: {
  mappingPairKey: string | null;
  platform: EvPlatform;
  pmOb?: CachedOrderBookMid | null;
  kalshiOb?: CachedOrderBookMid | null;
  pmMid?: number | null;
  kalshiMid?: number | null;
}):
  | {
      pTrue: number;
      pmMid: number | null;
      kalshiMid: number | null;
      pricingMode: PricingMode;
    }
  | null {
  const pmResting =
    restingMidFromOrderBook(input.pmOb) ?? input.pmMid ?? null;
  const kalshiResting =
    restingMidFromOrderBook(input.kalshiOb) ?? input.kalshiMid ?? null;

  if (input.mappingPairKey) {
    const pTrue = liquidityWeightedCrossMid(
      input.pmOb,
      input.kalshiOb,
      pmResting,
      kalshiResting
    );
    if (pTrue == null) return null;
    return {
      pTrue,
      pmMid: pmResting,
      kalshiMid: kalshiResting,
      pricingMode: "paired_cross",
    };
  }

  const standalone = platformRestingMid(
    input.platform,
    pmResting,
    kalshiResting
  );
  if (standalone == null) return null;

  return {
    pTrue: standalone,
    pmMid: pmResting,
    kalshiMid: kalshiResting,
    pricingMode: "standalone_resting",
  };
}

/** Unified EV: (pTrue − executionPrice) × 100 display units. */
export function computeNetEvPercentFromExecution(
  pTrue: number,
  executionPrice: number
): number {
  return toEvDisplayPercent(pTrue - executionPrice);
}

/**
 * Full trade EV pricing — paired cross-mid or standalone resting baseline,
 * always anchored to execution price when provided.
 */
export function computeTradeEvPricing(
  input: TradeEvPricingInput
): TradeEvPricingResult | null {
  const executionPrice = normalizeIncomingTradePrice(input.executionPrice) ?? null;
  const tokenId = normalizePmTokenId(input.tokenId);
  const kalshiTicker = normalizeKalshiTicker(input.kalshiTicker);
  const mappingPairKey =
    input.mappingPairKey ??
    (tokenId && kalshiTicker
      ? pipelineMappingPairKey(tokenId, kalshiTicker)
      : null);

  const priced = computePricingPTrue({
    mappingPairKey,
    platform: input.platform,
    pmOb: input.pmOb,
    kalshiOb: input.kalshiOb,
    pmMid: input.pmMid,
    kalshiMid: input.kalshiMid,
  });

  if (!priced) return null;

  const platformMid = platformRestingMid(
    input.platform,
    priced.pmMid,
    priced.kalshiMid
  );
  const pMarket = executionPrice ?? platformMid ?? priced.pTrue;

  let netEvPercent: number;
  if (executionPrice != null) {
    netEvPercent = computeNetEvPercentFromExecution(
      priced.pTrue,
      executionPrice
    );
  } else if (
    priced.pricingMode === "paired_cross" &&
    priced.pmMid != null &&
    priced.kalshiMid != null
  ) {
    netEvPercent = toEvDisplayPercent(
      Math.abs(priced.pmMid - priced.kalshiMid)
    );
  } else {
    netEvPercent = 0;
  }

  const netEv = priced.pTrue - pMarket;
  const grossEv = netEv;
  const grossEvPercent = netEvPercent;

  return {
    pTrue: priced.pTrue,
    pMarket,
    netEvPercent: sanitizeEvPercent(netEvPercent),
    netEv: sanitizeEvPercent(netEv),
    grossEv: sanitizeEvPercent(grossEv),
    grossEvPercent: sanitizeEvPercent(grossEvPercent),
    pmMid: priced.pmMid,
    kalshiMid: priced.kalshiMid,
    pricingMode: priced.pricingMode,
  };
}

export function buildPipelineTradeEvFromPricing(
  input: TradeEvPricingInput
): PipelineTradeEv | null {
  const pricing = computeTradeEvPricing(input);
  if (!pricing) return null;

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
    executionPrice: input.executionPrice,
    tokenId,
    kalshiTicker,
  });

  if (!priced) return { ...record, key: lookupKey };

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
  };
}
