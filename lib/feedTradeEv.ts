import { resolveDetailPanelDisplayEv } from "@/lib/evPipeline/tradeEvRecord";
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

/** Trade-level EV % for feed gates — never falls back to wallet average EV. */
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

  if (!pipeline) return null;

  const detail = resolveDetailPanelDisplayEv(pipeline, trade.price);
  if (detail) return detail.netEvPercent;

  return tradeLevelEvPercent({
    netEvPercent: pipeline.netEvPercent,
    grossEvPercent: pipeline.grossEvPercent,
  });
}
