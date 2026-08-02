import {
  deriveEvPercentFromPTrue,
} from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";

function tradeLevelEvPercent(input: {
  tradeEvPercent?: number | null;
  netEvPercent?: number | null;
  grossEvPercent?: number | null;
}): number | null {
  if (input.tradeEvPercent != null && Number.isFinite(input.tradeEvPercent)) {
    return input.tradeEvPercent;
  }
  for (const value of [input.netEvPercent, input.grossEvPercent]) {
    if (value != null && Number.isFinite(value)) return value;
  }
  return null;
}

/** Skip synthetic 50/50 priors when deriving feed trade EV from p_true. */
function isAuthoritativePipelinePTrue(pipeline: PipelineTradeEv): boolean {
  if (pipeline.pTrueLowConfidence) return false;
  if (pipeline.pTrueSource === "universal_prior") return false;
  if (
    pipeline.pTrueConfidence != null &&
    Number.isFinite(pipeline.pTrueConfidence) &&
    pipeline.pTrueConfidence < 0.35
  ) {
    return false;
  }
  return pipeline.pTrue != null && Number.isFinite(pipeline.pTrue);
}

/** Trade-level EV % for feed gates — never uses wallet averageEv / traderAvgEv. */
export function resolveFeedTradeEvPercent(
  trade: {
    price: number;
    tradeEvPercent?: number | null;
    netEvPercent?: number | null;
    grossEvPercent?: number | null;
  },
  pipeline?: PipelineTradeEv | null
): number | null {
  const fromTrade = tradeLevelEvPercent(trade);
  if (fromTrade != null) return fromTrade;

  if (!pipeline || pipeline.status === "unmapped") return null;

  const fromPipeline = tradeLevelEvPercent({
    netEvPercent: pipeline.netEvPercent,
    grossEvPercent: pipeline.grossEvPercent,
  });
  if (fromPipeline != null) return fromPipeline;

  if (isAuthoritativePipelinePTrue(pipeline)) {
    return deriveEvPercentFromPTrue(
      pipeline.pTrue!,
      trade.price,
      pipeline.pMarket ?? pipeline.pmMid ?? pipeline.kalshiMid
    );
  }

  return null;
}
