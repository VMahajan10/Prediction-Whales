/**
 * Shadow x-agent watcher — warms EV pipeline + scans whale trades every 15 minutes.
 *
 * Usage:
 *   npm run shadow:watch
 *
 * Env:
 *   DATABASE_URL              — Prisma + pipeline DB stages
 *   SHADOW_CRON_INTERVAL_MS   — default 900000 (15 minutes)
 */
import { register } from "tsconfig-paths";
import { resolve } from "path";

register({
  baseUrl: resolve(__dirname, ".."),
  paths: {
    "@/*": ["./*"],
    "@kalshi/sdk": ["./lib/kalshi-sdk"],
  },
});

import { loadEnvFiles } from "./loadEnv";

loadEnvFiles();

import { runXAgentShadowPipeline } from "../lib/x-agent/runShadowPipeline";
import { getPrisma, isPrismaEnabled } from "../lib/prisma";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

const PENDING_QUEUE_STATUSES = [
  "PENDING",
  "PENDING_REVIEW",
  "EDITED",
  "APPROVED",
] as const;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function resolveIntervalMs(): number {
  const raw = process.env.SHADOW_CRON_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

async function countPendingXPostQueue(): Promise<number | null> {
  if (!isPrismaEnabled()) return null;

  const prisma = getPrisma();
  if (!prisma) return null;

  try {
    return await prisma.xPostQueue.count({
      where: { status: { in: [...PENDING_QUEUE_STATUSES] } },
    });
  } catch (err) {
    console.warn(
      `[${formatTimestamp()}] shadow-cron pending queue count failed:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function runShadowCycle(cycle: number): Promise<void> {
  const startedAt = new Date();
  const t0 = Date.now();

  console.log(`[${formatTimestamp(startedAt)}] shadow-cron #${cycle} started`);

  let result: Awaited<ReturnType<typeof runXAgentShadowPipeline>> | null = null;
  let cycleError: string | undefined;

  try {
    result = await runXAgentShadowPipeline();
  } catch (err) {
    cycleError = err instanceof Error ? err.message : String(err);
    console.error(
      `[${formatTimestamp()}] shadow-cron #${cycle} error:`,
      cycleError
    );
  }

  const pendingQueue = await countPendingXPostQueue();
  const durationMs = Date.now() - t0;

  const pendingLabel =
    pendingQueue == null ? "n/a" : String(pendingQueue);

  if (result) {
    const status =
      !result.error && result.whalesFailed === 0 ? "ok" : "partial";

    console.log(
      `[${formatTimestamp()}] shadow-cron #${cycle} finished | duration=${formatDuration(durationMs)} | evPipeline=${result.evPipelineOk ? "ok" : "error"} | whalesFetched=${result.whalesFetched} | whalesProcessed=${result.whalesProcessed} | whalesFailed=${result.whalesFailed} | pendingXPostQueue=${pendingLabel} | status=${status}${result.error ? ` | error=${result.error}` : ""}`
    );
  } else {
    console.log(
      `[${formatTimestamp()}] shadow-cron #${cycle} finished | duration=${formatDuration(durationMs)} | pendingXPostQueue=${pendingLabel} | status=error${cycleError ? ` | error=${cycleError}` : ""}`
    );
  }
}

async function main(): Promise<void> {
  const intervalMs = resolveIntervalMs();

  console.log(
    `[${formatTimestamp()}] shadow-cron watching x-agent pipeline | interval=${formatDuration(intervalMs)}`
  );

  let cycle = 0;
  let running = true;

  const shutdown = () => {
    if (!running) return;
    running = false;
    console.log(`[${formatTimestamp()}] shadow-cron stopping…`);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    cycle += 1;

    try {
      await runShadowCycle(cycle);
    } catch (err) {
      console.error(
        `[${formatTimestamp()}] shadow-cron #${cycle} unhandled:`,
        err instanceof Error ? err.message : err
      );
    }

    if (!running) break;

    console.log(
      `[${formatTimestamp()}] shadow-cron sleeping ${formatDuration(intervalMs)} until next run`
    );

    const wakeAt = Date.now() + intervalMs;
    while (running && Date.now() < wakeAt) {
      await sleep(Math.min(1000, wakeAt - Date.now()));
    }
  }
}

main().catch((err) => {
  console.error(
    `[${formatTimestamp()}] shadow-cron fatal:`,
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
