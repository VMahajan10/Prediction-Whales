import {
  coalesceDisplayEvPercent,
  isStaleZeroAverageEvPayload,
  isStaleZeroTradeEvPayload,
  resolveDetailPanelDisplayEv,
} from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { formatEvPercent } from "@/lib/crossMarketEvDisplay";
import { pipelineEvTone } from "@/lib/evPipeline/tradeEvRecord";
import { resolveFeedTradeEvPercent } from "@/lib/feedTradeEv";
import type { WhaleTrade } from "@/lib/whaleTrades";

export interface WhaleCardAvgEvDisplay {
  value: string;
  valueClass: string;
  lowConfidence: boolean;
}

/** True when the trade carries a real stamped trade EV (not schema-default 0). */
export function whaleHasStampedFeedEv(trade: WhaleTrade): boolean {
  const fields = {
    netEvPercent: trade.netEvPercent ?? null,
    grossEvPercent: trade.grossEvPercent ?? null,
    averageEv: trade.averageEv ?? null,
  };
  if (
    isStaleZeroAverageEvPayload(fields) ||
    isStaleZeroTradeEvPayload({
      ...fields,
      pmMid: null,
      kalshiMid: null,
      pTrue: null,
      pMarket: null,
    })
  ) {
    return false;
  }
  return coalesceDisplayEvPercent(fields) != null;
}

/**
 * Freeze the gate-passing trade EV onto a feed row so later pipeline refreshes
 * cannot drift the card to N/A or a live negative edge.
 */
export function stampWhaleFeedAdmissionEv(
  trade: WhaleTrade,
  tradeEvPercent: number
): WhaleTrade {
  if (!Number.isFinite(tradeEvPercent)) return trade;
  if (whaleHasStampedFeedEv(trade)) return trade;
  return {
    ...trade,
    netEvPercent: tradeEvPercent,
    averageEv: tradeEvPercent,
  };
}

/**
 * Merge pipeline EV fields onto a whale row for card display.
 *
 * Delegates to `resolveFeedTradeEvPercent` so the rendered number is the exact
 * value the feed gate admitted the trade on — non-authoritative p_true is
 * withheld here for the same reason it is withheld from the gate.
 */
export function mergePipelineEvOntoWhale(
  trade: WhaleTrade,
  pipeline: PipelineTradeEv | null | undefined
): WhaleTrade {
  const fields = {
    netEvPercent: trade.netEvPercent ?? null,
    grossEvPercent: trade.grossEvPercent ?? null,
    averageEv: trade.averageEv ?? null,
  };
  const existing = coalesceDisplayEvPercent(fields);
  const staleStamped =
    existing != null &&
    isStaleZeroTradeEvPayload({
      ...fields,
      pmMid: null,
      kalshiMid: null,
      pTrue: pipeline?.pTrue ?? null,
      pMarket: pipeline?.pMarket ?? null,
    });
  if (existing != null && !staleStamped) return trade;

  const tradeEvPercent = resolveFeedTradeEvPercent(
    {
      price: trade.price,
      netEvPercent: trade.netEvPercent,
      grossEvPercent: trade.grossEvPercent,
    },
    pipeline
  );
  if (tradeEvPercent == null || !Number.isFinite(tradeEvPercent)) return trade;
  if (tradeEvPercent === 0 || Object.is(tradeEvPercent, -0)) return trade;

  return { ...trade, netEvPercent: tradeEvPercent, averageEv: tradeEvPercent };
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
  const staleTradeEv =
    tradeLevelEv != null &&
    isStaleZeroTradeEvPayload({
      netEvPercent: trade.netEvPercent ?? null,
      grossEvPercent: trade.grossEvPercent ?? null,
      averageEv: trade.averageEv ?? null,
      pmMid: pipelineData?.pmMid ?? null,
      kalshiMid: pipelineData?.kalshiMid ?? null,
      pTrue: pipelineData?.pTrue ?? null,
      pMarket: pipelineData?.pMarket ?? null,
    });
  if (tradeLevelEv != null && !staleTradeEv) {
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
