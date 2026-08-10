import "server-only";

import { coalesceDisplayEvPercent } from "@/lib/evPipeline/tradeEvRecord";
import type { PipelineTradeEv } from "@/lib/evPipeline/types";
import {
  HIGH_EV_TRADE_THRESHOLD_PCT,
  X_AGENT_EV_BYPASS_STAKE_USD,
  X_AGENT_NEUTRAL_EV_STAKE_USD,
} from "@/lib/x-agent/gateMetrics";

/**
 * Normalize pipeline EV for x_post_queue gating — whale tiers neutralize
 * timeout/degraded baselines instead of rejecting on small negative edges.
 */
export function resolveXAgentQueueEvPercent(
  pipeline: PipelineTradeEv | null | undefined,
  stakeNotional: number
): number | null {
  const raw = pipeline ? coalesceDisplayEvPercent(pipeline) : null;

  if (stakeNotional >= X_AGENT_EV_BYPASS_STAKE_USD) {
    return raw != null && Number.isFinite(raw) ? raw : 0;
  }

  if (stakeNotional >= X_AGENT_NEUTRAL_EV_STAKE_USD) {
    if (raw == null) return 0;
    if (
      pipeline?.status === "timeout" ||
      pipeline?.pTrueLowConfidence === true ||
      (raw < 0 && raw > -2)
    ) {
      return 0;
    }
  }

  return raw;
}

export function meetsXAgentTradeEvGate(
  tradeEvPercent: number | null,
  stakeNotional = 0
): boolean {
  if (stakeNotional >= X_AGENT_EV_BYPASS_STAKE_USD) return true;
  if (tradeEvPercent == null) {
    return stakeNotional >= X_AGENT_NEUTRAL_EV_STAKE_USD;
  }
  return tradeEvPercent >= HIGH_EV_TRADE_THRESHOLD_PCT;
}
