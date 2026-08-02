import { calculateTrueEV, type EvPlatform } from "@/lib/finance/evEngine";
import {
  abstainPipelineTradeEvFromPTrue,
  isAuthoritativePTrueForEv,
} from "@/lib/evPipeline/pTrueAuthority";
import type { PTrueResult } from "@/lib/evPipeline/pTrueTypes";
import { EV_FORMULA_VERSION } from "@/lib/evPipeline/pTrueTypes";
import {
  normalizeIncomingTradePrice,
  sanitizeEvPercent,
  sanitizeProbDelta,
  toEvDisplayPercent,
} from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  normalizeKalshiTicker,
  normalizePmTokenId,
} from "@/lib/evPipeline/crossAssetLookup";

export interface TradeEvDisplayResult {
  grossEv: number;
  netEv: number;
  netEvPercent: number;
  grossEvPercent: number;
  averageEv: number;
  pMarket: number;
  formula: typeof EV_FORMULA_VERSION;
}

export interface ComputeTradeEvDisplayParams {
  pTrue: number;
  executionPrice?: number | null;
  platform: EvPlatform;
  /** Reference market when execution price is absent. */
  pMarketFallback?: number | null;
}

/**
 * Canonical binary EV:
 *   EV = p_true × (1 − p_market) − (1 − p_true) × p_market
 * Net EV subtracts platform fee drag via calculateTrueEV.
 */
export function computeTradeEvDisplay(
  params: ComputeTradeEvDisplayParams
): TradeEvDisplayResult {
  const execution = normalizeIncomingTradePrice(params.executionPrice);
  const pMarket =
    execution ??
    (params.pMarketFallback != null && Number.isFinite(params.pMarketFallback)
      ? params.pMarketFallback
      : params.pTrue);

  const breakdown = calculateTrueEV(params.pTrue, pMarket, params.platform);

  const grossEvPercent = sanitizeEvPercent(toEvDisplayPercent(breakdown.grossEv));
  const netEvPercent = sanitizeEvPercent(toEvDisplayPercent(breakdown.netEv));

  return {
    grossEv: sanitizeProbDelta(breakdown.grossEv),
    netEv: sanitizeProbDelta(breakdown.netEv),
    grossEvPercent,
    netEvPercent,
    averageEv: netEvPercent,
    pMarket,
    formula: EV_FORMULA_VERSION,
  };
}

export function attachEvMetadata(
  record: PipelineTradeEv,
  pTrueResult: PTrueResult,
  evDisplay: TradeEvDisplayResult
): PipelineTradeEv {
  return {
    ...record,
    pTrue: pTrueResult.pTrue,
    pMarket: evDisplay.pMarket,
    pTrueSource: pTrueResult.source,
    pTrueConfidence: pTrueResult.confidence,
    pTrueLowConfidence: pTrueResult.lowConfidence,
    evFormulaVersion: evDisplay.formula,
    netEv: evDisplay.netEv,
    grossEv: evDisplay.grossEv,
    netEvPercent: evDisplay.netEvPercent,
    grossEvPercent: evDisplay.grossEvPercent,
    averageEv: evDisplay.averageEv,
    pmMid: pTrueResult.pmMid,
    kalshiMid: pTrueResult.kalshiMid,
  };
}

export function buildPipelineTradeEvFromPTrue(
  lookupKey: string,
  pTrueResult: PTrueResult,
  params: {
    platform: EvPlatform;
    tokenId?: string | null;
    kalshiTicker?: string | null;
    mappingPairKey?: string | null;
    executionPrice?: number | null;
  }
): PipelineTradeEv {
  const tokenId = normalizePmTokenId(params.tokenId);
  const kalshiTicker = normalizeKalshiTicker(params.kalshiTicker);

  if (!isAuthoritativePTrueForEv(pTrueResult)) {
    return abstainPipelineTradeEvFromPTrue(lookupKey, pTrueResult, {
      tokenId,
      kalshiTicker,
      mappingPairKey: params.mappingPairKey,
    });
  }

  const platformMid =
    params.platform === "polymarket"
      ? pTrueResult.pmMid
      : pTrueResult.kalshiMid;

  const evDisplay = computeTradeEvDisplay({
    pTrue: pTrueResult.pTrue,
    executionPrice: params.executionPrice,
    platform: params.platform,
    pMarketFallback: platformMid ?? pTrueResult.marketPrior,
  });

  return attachEvMetadata(
    {
      key: lookupKey,
      status: "ok",
      tokenId,
      kalshiTicker,
      mappingPairKey: params.mappingPairKey ?? null,
      netEvPercent: null,
      netEv: 0,
    },
    pTrueResult,
    evDisplay
  );
}
