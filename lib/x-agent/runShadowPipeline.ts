import { randomUUID } from "node:crypto";
import { fetchWhaleBackfill } from "@/lib/polymarket";
import { runEvPipeline } from "@/lib/evPipeline/pipeline";
import {
  acquirePipelineLock,
  releasePipelineLock,
  writePipelineMeta,
} from "@/lib/evPipeline/redisCache";
import { tradeToWhale } from "@/lib/whaleTrades";
import { processWhaleTradeForXAgent } from "@/lib/x-agent/enqueueWhaleTrade";

export interface XAgentShadowPipelineResult {
  evPipelineOk: boolean;
  whalesFetched: number;
  whalesProcessed: number;
  whalesFailed: number;
  error?: string;
}

/**
 * Warm the EV pipeline, then scan recent whale trades and run each through
 * the x-agent EV gate / registry upsert / XPostQueue enqueue path.
 */
export async function runXAgentShadowPipeline(): Promise<XAgentShadowPipelineResult> {
  const runId = randomUUID();
  let evPipelineOk = false;
  let evError: string | undefined;

  const locked = await acquirePipelineLock(runId);
  if (locked) {
    try {
      const result = await runEvPipeline(runId);
      await writePipelineMeta({
        runId,
        finishedAt: new Date().toISOString(),
        stages: result.stages,
      });

      evPipelineOk = Object.values(result.stages).every((stage) => stage.ok);
      if (!evPipelineOk) {
        evError = Object.values(result.stages)
          .filter((stage) => !stage.ok && stage.error)
          .map((stage) => stage.error)
          .join("; ");
      }
    } catch (err) {
      evError = err instanceof Error ? err.message : String(err);
    } finally {
      await releasePipelineLock(runId);
    }
  } else {
    evError = "EV pipeline lock held — skipped EV warm-up";
  }

  let trades: Awaited<ReturnType<typeof fetchWhaleBackfill>> = [];

  try {
    trades = await fetchWhaleBackfill();
  } catch (err) {
    return {
      evPipelineOk,
      whalesFetched: 0,
      whalesProcessed: 0,
      whalesFailed: 0,
      error:
        evError ??
        (err instanceof Error ? err.message : "Failed to fetch whale trades"),
    };
  }

  let whalesProcessed = 0;
  let whalesFailed = 0;

  for (const trade of trades) {
    if (!trade.proxyWallet?.trim() || !trade.assetId?.trim()) continue;

    const whale = tradeToWhale(trade, {
      source: "polymarket",
      usdNotional: trade.size,
      isLive: false,
    });

    try {
      await processWhaleTradeForXAgent(whale);
      whalesProcessed += 1;
    } catch (err) {
      whalesFailed += 1;
      console.warn(
        "[x-agent/shadow] trade processing failed",
        trade.id,
        err instanceof Error ? err.message : err
      );
    }
  }

  return {
    evPipelineOk,
    whalesFetched: trades.length,
    whalesProcessed,
    whalesFailed,
    error: evError,
  };
}
