import type { PTrueResult, PTrueSource } from "@/lib/evPipeline/pTrueTypes";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";

const MIN_AUTHORITATIVE_CONFIDENCE = 0.35;

/** Whether p_true is safe to anchor trade-level EV (not a synthetic 50/50 prior). */
export function isAuthoritativePTrueForEv(input: {
  source?: PTrueSource | null;
  confidence?: number | null;
  lowConfidence?: boolean;
}): boolean {
  if (input.source === "universal_prior" || input.source === "execution_price") {
    return false;
  }
  if (input.lowConfidence) return false;
  if (
    input.confidence != null &&
    Number.isFinite(input.confidence) &&
    input.confidence < MIN_AUTHORITATIVE_CONFIDENCE
  ) {
    return false;
  }
  return true;
}

export function isAuthoritativePipelineTradeEv(
  pipeline: PipelineTradeEv
): boolean {
  if (pipeline.status !== "ok") return false;
  if (pipeline.pTrueLowConfidence) return false;

  if (
    !isAuthoritativePTrueForEv({
      source: pipeline.pTrueSource,
      confidence: pipeline.pTrueConfidence,
      lowConfidence: pipeline.pTrueLowConfidence,
    })
  ) {
    return false;
  }

  const hasPipelineEv =
    pipeline.netEvPercent != null &&
    Number.isFinite(pipeline.netEvPercent) &&
    !(pipeline.netEvPercent === 0 && pipeline.pmMid == null && pipeline.kalshiMid == null);
  const hasAuthoritativePTrue =
    pipeline.pTrue != null && Number.isFinite(pipeline.pTrue);

  return hasPipelineEv || hasAuthoritativePTrue;
}

export function abstainPipelineTradeEvFromPTrue(
  lookupKey: string,
  pTrueResult: PTrueResult,
  params: {
    tokenId?: string | null;
    kalshiTicker?: string | null;
    mappingPairKey?: string | null;
  }
): PipelineTradeEv {
  return {
    key: lookupKey,
    status: "unmapped",
    tokenId: params.tokenId ?? null,
    kalshiTicker: params.kalshiTicker ?? null,
    mappingPairKey: params.mappingPairKey ?? null,
    netEvPercent: null,
    netEv: 0,
    grossEv: 0,
    grossEvPercent: null,
    averageEv: null,
    pTrue: null,
    pMarket: null,
    pTrueSource: pTrueResult.source,
    pTrueConfidence: pTrueResult.confidence,
    pTrueLowConfidence: true,
    pmMid: pTrueResult.pmMid,
    kalshiMid: pTrueResult.kalshiMid,
  };
}
