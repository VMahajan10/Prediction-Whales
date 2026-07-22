import {
  coalesceDisplayEvPercent,
  resolveDetailPanelDisplayEv,
} from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import { pipelineEvTone } from "@/lib/evPipeline/tradeEvRecord";
import type { WhaleTrade } from "@/lib/whaleTrades";

export interface WhaleCardAvgEvDisplay {
  value: string;
  valueClass: string;
  lowConfidence: boolean;
}

/** Merge pipeline EV fields onto a whale row for immediate card display. */
export function mergePipelineEvOntoWhale(
  trade: WhaleTrade,
  pipeline: PipelineTradeEv | null | undefined
): WhaleTrade {
  if (!pipeline) return trade;

  const netEvPercent =
    trade.netEvPercent ?? pipeline.netEvPercent ?? pipeline.grossEvPercent ?? null;
  const averageEv =
    trade.averageEv ?? pipeline.averageEv ?? pipeline.netEvPercent ?? null;

  if (
    netEvPercent === trade.netEvPercent &&
    averageEv === trade.averageEv &&
    trade.grossEvPercent == null &&
    pipeline.grossEvPercent == null
  ) {
    return trade;
  }

  return {
    ...trade,
    netEvPercent,
    grossEvPercent: trade.grossEvPercent ?? pipeline.grossEvPercent ?? null,
    averageEv,
  };
}

function formatEvPercentDisplay(
  netEvPercent: number,
  lowConfidence = false
): Pick<WhaleCardAvgEvDisplay, "value" | "valueClass"> {
  const formatted = formatEvPercent(netEvPercent);
  const value = lowConfidence ? `~${formatted}` : formatted;
  const { positive, negative } = pipelineEvTone(netEvPercent);
  const valueClass = positive
    ? "text-emerald-500 font-semibold"
    : negative
      ? "text-rose-500 font-semibold"
      : "text-pulse-label";

  return { value, valueClass };
}

/** Synchronous AVG EV label for whale feed cards — never blocks on async loading. */
export function resolveWhaleCardAvgEv(
  trade: WhaleTrade,
  pipelineData: PipelineTradeEv | null | undefined,
  hasLookupKey: boolean
): WhaleCardAvgEvDisplay {
  if (!hasLookupKey) {
    return { value: "N/A", valueClass: "text-pulse-label", lowConfidence: false };
  }

  if (pipelineData?.status === "unmapped") {
    return { value: "—", valueClass: "text-pulse-label", lowConfidence: false };
  }

  const tradeLevelEv = coalesceDisplayEvPercent({
    netEvPercent: trade.netEvPercent ?? null,
    grossEvPercent: trade.grossEvPercent ?? null,
    averageEv: trade.averageEv ?? null,
  });
  if (tradeLevelEv != null) {
    return {
      ...formatEvPercentDisplay(tradeLevelEv, false),
      lowConfidence: false,
    };
  }

  const fromPipeline = resolveDetailPanelDisplayEv(pipelineData, trade.price);
  if (fromPipeline) {
    return {
      ...formatEvPercentDisplay(
        fromPipeline.netEvPercent,
        fromPipeline.lowConfidence
      ),
      lowConfidence: fromPipeline.lowConfidence,
    };
  }

  const pipelineOnly = coalesceDisplayEvPercent(pipelineData);
  if (pipelineOnly != null) {
    return {
      ...formatEvPercentDisplay(pipelineOnly, false),
      lowConfidence: false,
    };
  }

  return { value: "—", valueClass: "text-pulse-label", lowConfidence: false };
}

export function whaleCardEvKey(trade: WhaleTrade): string {
  return trade.source === "kalshi"
    ? `kalshi:${trade.id}`
    : trade.transactionHash || trade.id;
}
