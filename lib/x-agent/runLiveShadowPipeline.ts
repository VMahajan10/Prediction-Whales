import { randomUUID } from "node:crypto";
import {
  PolymarketLiveSocket,
  type SocketTrade,
} from "@/lib/polymarketLiveSocket";
import { runEvPipeline } from "@/lib/evPipeline/pipeline";
import {
  runWithPipelineLock,
  writePipelineMeta,
} from "@/lib/evPipeline/redisCache";
import { processWhaleTradeForXAgent } from "@/lib/x-agent/enqueueWhaleTrade";
import {
  createGateSummary,
} from "@/lib/x-agent/gateMetrics";
import {
  EV_PIPELINE_LOCK_HELD_MESSAGE,
  type XAgentShadowPipelineResult,
} from "@/lib/x-agent/runShadowPipeline";
import { socketTradeToWhale } from "@/lib/x-agent/runShadowDaemon";

export interface LiveShadowPipelineOptions {
  /** Wall-clock cap for the live listen window (default 10 minutes). */
  durationMs?: number;
  /** Stop after this many gate-matrix evaluations (default 100). */
  maxEvaluations?: number;
}

const DEFAULT_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_MAX_EVALUATIONS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Warm the EV pipeline, subscribe to the live Polymarket WebSocket feed, and
 * evaluate each detected whale trade through the x-agent gate matrix.
 */
export async function runXAgentLiveShadowPipeline(
  options: LiveShadowPipelineOptions = {}
): Promise<XAgentShadowPipelineResult> {
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  const maxEvaluations = options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS;
  const runId = randomUUID();
  const gateSummary = createGateSummary();

  const lockResult = await runWithPipelineLock(runId, async () => {
    try {
      const result = await runEvPipeline(runId);
      await writePipelineMeta({
        runId,
        finishedAt: new Date().toISOString(),
        stages: result.stages,
      });

      const ok = Object.values(result.stages).every((stage) => stage.ok);
      const error = ok
        ? undefined
        : Object.values(result.stages)
            .filter((stage) => !stage.ok && stage.error)
            .map((stage) => stage.error)
            .join("; ");

      return { evPipelineOk: ok, evError: error };
    } catch (err) {
      return {
        evPipelineOk: false,
        evError: err instanceof Error ? err.message : String(err),
      };
    }
  });

  if (!lockResult.acquired) {
    return {
      evPipelineOk: false,
      whalesFetched: 0,
      whalesProcessed: 0,
      whalesFailed: 0,
      gateSummary,
      error: EV_PIPELINE_LOCK_HELD_MESSAGE,
    };
  }

  const evPipelineOk = lockResult.value.evPipelineOk;
  const evError = lockResult.value.evError;

  let tradesReceived = 0;
  let whalesProcessed = 0;
  let whalesFailed = 0;
  let evaluations = 0;
  let stopReason: "duration" | "max_evaluations" | "stopped" = "duration";

  const pending: SocketTrade[] = [];
  let draining = false;
  let socket: PolymarketLiveSocket | null = null;
  let finished = false;

  const maybeFinish = (reason: typeof stopReason) => {
    if (finished) return;
    if (evaluations >= maxEvaluations) {
      finished = true;
      stopReason = "max_evaluations";
      socket?.stop();
    } else if (reason !== "stopped") {
      finished = true;
      stopReason = reason;
      socket?.stop();
    }
  };

  const drainQueue = async (): Promise<void> => {
    if (draining || finished) return;
    draining = true;

    while (pending.length > 0 && !finished) {
      const trade = pending.shift();
      if (!trade) break;
      if (!trade.assetId?.trim()) continue;

      try {
        const whale = await socketTradeToWhale(trade);
        await processWhaleTradeForXAgent(whale, gateSummary);
        whalesProcessed += 1;
      } catch (err) {
        whalesFailed += 1;
        console.warn(
          "[x-agent/shadow-live] trade processing failed",
          trade.id,
          err instanceof Error ? err.message : err
        );
      }

      evaluations += 1;
      if (evaluations >= maxEvaluations) {
        maybeFinish("max_evaluations");
        break;
      }
    }

    draining = false;
    if (pending.length > 0 && !finished) {
      void drainQueue();
    }
  };

  socket = new PolymarketLiveSocket({
    onTrade: async (trade) => {
      if (finished) return;
      tradesReceived += 1;
      if (evaluations + pending.length >= maxEvaluations) return;
      pending.push(trade);
      void drainQueue();
    },
  });

  console.log(
    `[x-agent/shadow-live] listening on Polymarket WebSocket | duration=${Math.round(durationMs / 1000)}s | maxEvaluations=${maxEvaluations}`
  );

  try {
    await socket.start();
  } catch (err) {
    return {
      evPipelineOk,
      whalesFetched: 0,
      whalesProcessed: 0,
      whalesFailed: 0,
      gateSummary,
      error:
        evError ??
        (err instanceof Error ? err.message : "Failed to start live socket"),
    };
  }

  const startedAt = Date.now();
  while (!finished && Date.now() - startedAt < durationMs) {
    await sleep(250);
  }

  if (!finished) {
    maybeFinish("duration");
  }

  while (draining || (pending.length > 0 && evaluations < maxEvaluations)) {
    await sleep(100);
  }

  console.log(
    `[x-agent/shadow-live] complete | reason=${stopReason} | socketTrades=${tradesReceived} | evaluated=${evaluations} | processed=${whalesProcessed} | failed=${whalesFailed}`
  );

  return {
    evPipelineOk,
    whalesFetched: tradesReceived,
    whalesProcessed,
    whalesFailed,
    gateSummary,
    error: evError,
  };
}

export function parseLiveShadowOptionsFromEnv(): LiveShadowPipelineOptions {
  const durationSec = Number(process.env.SHADOW_CRON_DURATION_SEC);
  const maxEvaluations = Number(process.env.SHADOW_CRON_MAX_TRADES);

  return {
    durationMs:
      Number.isFinite(durationSec) && durationSec > 0
        ? durationSec * 1000
        : DEFAULT_DURATION_MS,
    maxEvaluations:
      Number.isFinite(maxEvaluations) && maxEvaluations > 0
        ? maxEvaluations
        : DEFAULT_MAX_EVALUATIONS,
  };
}
