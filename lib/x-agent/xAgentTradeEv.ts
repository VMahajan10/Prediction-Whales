import "server-only";

import { coalesceDisplayEvPercent } from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import { HIGH_EV_TRADE_THRESHOLD_PCT } from "@/lib/x-agent/gateMetrics";

/**
 * Resolve pipeline EV for x_post_queue gating — no stake-tier neutralization.
 * Unresolved / timed-out payloads return null so the EV gate drops the trade.
 */
export function resolveXAgentQueueEvPercent(
  pipeline: PipelineTradeEv | null | undefined
): number | null {
  if (!pipeline) return null;

  if (
    pipeline.status === "timeout" ||
    pipeline.status === "unmapped" ||
    pipeline.status === "error"
  ) {
    return null;
  }

  return coalesceDisplayEvPercent(pipeline);
}

export function meetsXAgentTradeEvGate(tradeEvPercent: number | null): boolean {
  return (
    tradeEvPercent != null &&
    Number.isFinite(tradeEvPercent) &&
    tradeEvPercent >= HIGH_EV_TRADE_THRESHOLD_PCT
  );
}
