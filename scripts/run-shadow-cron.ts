/**
 * Shadow cron worker — 24/7 live Polymarket WebSocket gate evaluator.
 *
 * Cloud deployment:
 *   npm run start:worker
 *   # inject DATABASE_URL, OPENAI_API_KEY, UPSTASH_REDIS_* via platform env
 *
 * Local:
 *   npx tsx scripts/run-shadow-cron.ts
 *
 * Modes (SHADOW_CRON_MODE):
 *   daemon   — perpetual WebSocket listener (default)
 *   batch    — bounded live WebSocket run
 *   backfill — one-shot Polymarket Data API scan
 */
import { loadEnvFiles } from "./loadEnv";
import { bootstrapCloudWorker } from "./workerBootstrap";
import { printGateSummaryBox } from "../lib/x-agent/gateMetrics";
import {
  parseLiveShadowOptionsFromEnv,
  runXAgentLiveShadowPipeline,
} from "../lib/x-agent/runLiveShadowPipeline";
import {
  parseShadowDaemonOptionsFromEnv,
  runShadowCronDaemon,
  type ShadowCronDaemon,
} from "../lib/x-agent/runShadowDaemon";
import {
  EV_PIPELINE_LOCK_HELD_MESSAGE,
  runXAgentBackfillShadowPipeline,
  type XAgentShadowPipelineResult,
} from "../lib/x-agent/runShadowPipeline";
import { disconnectPrisma, getPrisma } from "../lib/prisma";

loadEnvFiles();
bootstrapCloudWorker();

const PENDING_QUEUE_STATUSES = [
  "PENDING",
  "PENDING_REVIEW",
  "EDITED",
  "APPROVED",
] as const;

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

type ShadowMode = "daemon" | "batch" | "backfill";

let daemon: ShadowCronDaemon | null = null;
let summaryTicker: NodeJS.Timeout | null = null;
let heartbeatTicker: NodeJS.Timeout | null = null;
let shuttingDown = false;

function formatTimestamp(date = new Date()): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m ${rem}s`;
}

function resolveShadowMode(): ShadowMode {
  const mode = (process.env.SHADOW_CRON_MODE ?? "daemon").trim().toLowerCase();
  if (mode === "backfill") return "backfill";
  if (mode === "batch" || mode === "live") return "batch";
  return "daemon";
}

function registerProcessHandlers(): void {
  process.on("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });

  process.on("uncaughtException", (error) => {
    console.error("[Shadow Cron] uncaughtException — worker stays alive", error);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[Shadow Cron] unhandledRejection — worker stays alive", reason);
  });
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[${formatTimestamp()}] [Shadow Cron] ${signal} — shutting down...`);

  if (heartbeatTicker) {
    clearInterval(heartbeatTicker);
    heartbeatTicker = null;
  }

  if (summaryTicker) {
    clearInterval(summaryTicker);
    summaryTicker = null;
  }

  if (daemon) {
    await daemon.stop();
    printGateSummaryBox(daemon.getRollingSummary(), {
      rollingWindow: daemon.getRollingWindowSize(),
    });
    daemon = null;
  }

  try {
    await disconnectPrisma();
  } catch (cleanupError) {
    console.error("[Shadow Cron] Error during database cleanup:", cleanupError);
    exitCode = 1;
  }

  process.exit(exitCode);
}

function startHeartbeat(): void {
  heartbeatTicker = setInterval(() => {
    if (!daemon) return;
    const stats = daemon.stats;
    console.log(
      `[${formatTimestamp()}] [Shadow Cron] heartbeat | wsConnected=${daemon.isConnected()} | observed=${stats.tradesObserved} | evaluated=${stats.tradesEvaluated} | processed=${stats.tradesProcessed} | failed=${stats.tradesFailed} | evPipeline=${stats.evPipelineOk ? "ok" : "degraded"}`
    );
  }, HEARTBEAT_INTERVAL_MS);
}

async function runBatchShadowPipeline(): Promise<XAgentShadowPipelineResult> {
  const liveOptions = parseLiveShadowOptionsFromEnv();
  console.log(
    `[${formatTimestamp()}] [Shadow Cron] mode=batch (bounded WebSocket) | durationSec=${Math.round((liveOptions.durationMs ?? 0) / 1000)} | maxTrades=${liveOptions.maxEvaluations}`
  );
  return runXAgentLiveShadowPipeline(liveOptions);
}

async function runBackfillShadowPipeline(): Promise<XAgentShadowPipelineResult> {
  console.log(
    `[${formatTimestamp()}] [Shadow Cron] mode=backfill (Polymarket Data API)`
  );
  return runXAgentBackfillShadowPipeline();
}

async function runDaemon(): Promise<void> {
  registerProcessHandlers();

  const options = parseShadowDaemonOptionsFromEnv();
  console.log(
    `[${formatTimestamp()}] [Shadow Cron] mode=daemon (24/7 WebSocket) | rollingWindow=${options.rollingWindowSize} | summaryEveryTrades=${options.summaryEveryTrades} | summaryEverySec=${Math.round((options.summaryEveryMs ?? 0) / 1000)}`
  );

  daemon = await runShadowCronDaemon(options);
  summaryTicker = daemon.startSummaryTicker();
  startHeartbeat();

  console.log(
    `[${formatTimestamp()}] [Shadow Cron] worker online — listening indefinitely (SIGINT/SIGTERM to stop)`
  );

  await new Promise<void>(() => {
    // Perpetual loop: WebSocket auto-reconnect lives inside PolymarketLiveSocket.
  });
}

async function runOneShot(): Promise<void> {
  const startedAt = Date.now();
  let exitCode = 0;

  try {
    const mode = resolveShadowMode();
    const result =
      mode === "backfill"
        ? await runBackfillShadowPipeline()
        : await runBatchShadowPipeline();

    if (result.error === EV_PIPELINE_LOCK_HELD_MESSAGE) {
      console.warn("[Shadow Cron] Lock held, skipping run");
      printGateSummaryBox(result.gateSummary);
      await shutdown("complete", 0);
      return;
    }

    let pendingQueue: number | null = null;
    const prisma = getPrisma();
    if (prisma) {
      try {
        pendingQueue = await prisma.xPostQueue.count({
          where: { status: { in: [...PENDING_QUEUE_STATUSES] } },
        });
      } catch (err) {
        console.warn(
          `[${formatTimestamp()}] [Shadow Cron] pending queue count failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    const durationMs = Date.now() - startedAt;
    const pendingLabel = pendingQueue == null ? "n/a" : String(pendingQueue);
    const status =
      !result.error && result.whalesFailed === 0 && result.evPipelineOk
        ? "ok"
        : "partial";

    console.log(
      `[${formatTimestamp()}] [Shadow Cron] Pipeline run complete. | duration=${formatDuration(durationMs)} | evPipeline=${result.evPipelineOk ? "ok" : "error"} | tradesObserved=${result.whalesFetched} | tradesProcessed=${result.whalesProcessed} | tradesFailed=${result.whalesFailed} | pendingXPostQueue=${pendingLabel} | status=${status}${result.error ? ` | error=${result.error}` : ""}`
    );

    printGateSummaryBox(result.gateSummary);
  } catch (error) {
    console.error("[Shadow Cron] Error executing pipeline:", error);
    exitCode = 1;
  }

  await shutdown("complete", exitCode);
}

async function main(): Promise<void> {
  console.log(`[${formatTimestamp()}] [Shadow Cron] Starting worker...`);

  const mode = resolveShadowMode();
  if (mode === "daemon") {
    await runDaemon();
    return;
  }

  await runOneShot();
}

main().catch(async (error) => {
  console.error("[Shadow Cron] Unhandled error:", error);
  await shutdown("fatal", 1);
});
