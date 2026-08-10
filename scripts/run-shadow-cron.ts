/**
 * Shadow cron worker — 24/7 live Polymarket WebSocket gate evaluator.
 *
 * Cloud deployment:
 *   npm run build:worker
 *   npm run start:worker
 *
 * Local:
 *   npx tsx scripts/run-shadow-cron.ts
 *
 * Modes (SHADOW_CRON_MODE):
 *   daemon   — perpetual WebSocket listener (default)
 *   batch    — bounded live WebSocket run
 *   backfill — one-shot Polymarket Data API scan
 */
import "./preload-env";

import { loadEnvFiles } from "./loadEnv";
import { bootstrapCloudWorker } from "./workerBootstrap";
import { logReviewEmailEnvAtStartup } from "../lib/email/sendReviewEmail";
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
import { getPrisma, disconnectPrisma } from "../lib/prisma";
import { ensureXPostQueueSchemaOnce } from "../lib/x-agent/ensureXPostQueueSchema";
import { runCronPublisher } from "../lib/x-agent/cronPublisher";
import {
  isXPublisherSchedulerActive,
  resolveXPublisherIntervalMs,
} from "../lib/x-agent/xPublisherScheduler";

const PENDING_QUEUE_STATUSES = [
  "PENDING",
  "PENDING_REVIEW",
  "EDITED",
  "DRAFT",
  "APPROVED",
  "SCHEDULED",
] as const;

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const KEEP_ALIVE_INTERVAL_MS = 60_000;

type ShadowMode = "daemon" | "batch" | "backfill";

let daemon: ShadowCronDaemon | null = null;
let summaryTicker: NodeJS.Timeout | null = null;
let heartbeatTicker: NodeJS.Timeout | null = null;
let keepAliveTicker: NodeJS.Timeout | null = null;
let scheduledPublisherTicker: NodeJS.Timeout | null = null;
let scheduledPublisherRunning = false;
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

  if (keepAliveTicker) {
    clearInterval(keepAliveTicker);
    keepAliveTicker = null;
  }

  if (scheduledPublisherTicker) {
    clearInterval(scheduledPublisherTicker);
    scheduledPublisherTicker = null;
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

/** Keep Node process alive indefinitely for continuous 24/7 worker. */
function startKeepAlive(): void {
  keepAliveTicker = setInterval(() => {
    // Keep alive ping
  }, KEEP_ALIVE_INTERVAL_MS);
}

/** Publish SCHEDULED x_post_queue rows whose scheduledAt has elapsed. */
async function runScheduledXPublisherTick(): Promise<void> {
  if (scheduledPublisherRunning) {
    console.log(
      `[${formatTimestamp()}] [Shadow Cron] [X Publisher] tick skipped — prior run still in progress`
    );
    return;
  }

  scheduledPublisherRunning = true;
  const startedAt = Date.now();

  console.log(
    `[${formatTimestamp()}] [Shadow Cron] [X Publisher] tick started`
  );

  try {
    const result = await runCronPublisher();
    console.log(
      `[${formatTimestamp()}] [Shadow Cron] [X Publisher] tick complete | duration=${formatDuration(Date.now() - startedAt)} | scanned=${result.scanned} published=${result.published} failed=${result.failed} skipped=${result.skipped}`
    );
  } catch (error) {
    console.error(
      `[${formatTimestamp()}] [Shadow Cron] [X Publisher] tick failed:`,
      error
    );
  } finally {
    scheduledPublisherRunning = false;
  }
}

function startScheduledPublisherTicker(): void {
  if (!isXPublisherSchedulerActive()) {
    console.log(
      `[${formatTimestamp()}] [Shadow Cron] [X Publisher] scheduler inactive — no x_post_queue polling (missing X credentials or SHADOW_CRON_X_PUBLISHER_ENABLED=false)`
    );
    return;
  }

  const intervalMs = resolveXPublisherIntervalMs();
  void runScheduledXPublisherTick();

  scheduledPublisherTicker = setInterval(() => {
    void runScheduledXPublisherTick();
  }, intervalMs);

  console.log(
    `[${formatTimestamp()}] [Shadow Cron] [X Publisher] scheduled — every ${intervalMs / 1000}s`
  );
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
  const options = parseShadowDaemonOptionsFromEnv();
  console.log(
    `[${formatTimestamp()}] [Shadow Cron] mode=daemon (24/7 WebSocket) | rollingWindow=${options.rollingWindowSize} | summaryEveryTrades=${options.summaryEveryTrades} | summaryEverySec=${Math.round((options.summaryEveryMs ?? 0) / 1000)}`
  );

  daemon = await runShadowCronDaemon(options);
  summaryTicker = daemon.startSummaryTicker();
  startHeartbeat();
  startKeepAlive();
  startScheduledPublisherTicker();

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

    await runScheduledXPublisherTick();
  } catch (error) {
    console.error("[Shadow Cron] Error executing pipeline:", error);
    exitCode = 1;
  }

  await shutdown("complete", exitCode);
}

async function main(): Promise<void> {
  // Installed before any bootstrap work so a failure during startup is logged
  // and drained through shutdown() instead of dying as a top-level throw.
  registerProcessHandlers();

  console.log(`[${formatTimestamp()}] [Shadow Cron] Starting worker...`);

  loadEnvFiles();
  logReviewEmailEnvAtStartup();
  bootstrapCloudWorker();

  const prisma = getPrisma();
  if (prisma) {
    try {
      await ensureXPostQueueSchemaOnce(prisma);
      console.log(
        `[${formatTimestamp()}] [Shadow Cron] x_post_queue schema patches applied`
      );
    } catch (error) {
      console.warn(
        `[${formatTimestamp()}] [Shadow Cron] x_post_queue schema patch failed (enqueue will retry):`,
        error instanceof Error ? error.message : error
      );
    }
  }

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
