/**
 * Single-run shadow cron for CI (GitHub Actions) and manual invocation.
 * Runs one pipeline pass, closes DB connections, and exits — no watch loop.
 *
 * Usage:
 *   npx tsx scripts/run-shadow-cron.ts
 */
import { loadEnvFiles } from "./loadEnv";
import { runXAgentShadowPipeline } from "../lib/x-agent/runShadowPipeline";
import { disconnectPrisma, getPrisma } from "../lib/prisma";

console.log('[DEBUG] OPENAI_API_KEY present:', Boolean(process.env.OPENAI_API_KEY));
console.log('[DEBUG] ODDS_API_KEY present:', Boolean(process.env.ODDS_API_KEY));

loadEnvFiles();

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

async function shutdown(exitCode: number): Promise<never> {
  try {
    await disconnectPrisma();
  } catch (cleanupError) {
    console.error("[Shadow Cron] Error during database cleanup:", cleanupError);
    exitCode = 1;
  }

  process.exit(exitCode);
}

async function runCron(): Promise<void> {
  const startedAt = Date.now();
  let exitCode = 0;

  try {
    console.log(
      `[${formatTimestamp()}] [Shadow Cron] Starting pipeline run...`
    );

    const result = await runXAgentShadowPipeline();

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

    if (!result.evPipelineOk || result.whalesFailed > 0 || result.error) {
      exitCode = 1;
    }

    console.log(
      `[${formatTimestamp()}] [Shadow Cron] Pipeline run complete. | duration=${formatDuration(durationMs)} | evPipeline=${result.evPipelineOk ? "ok" : "error"} | whalesFetched=${result.whalesFetched} | whalesProcessed=${result.whalesProcessed} | whalesFailed=${result.whalesFailed} | pendingXPostQueue=${pendingLabel} | status=${status}${result.error ? ` | error=${result.error}` : ""}`
    );
  } catch (error) {
    console.error("[Shadow Cron] Error executing pipeline:", error);
    exitCode = 1;
  }

  await shutdown(exitCode);
}

runCron().catch(async (error) => {
  console.error("[Shadow Cron] Unhandled error:", error);
  await shutdown(1);
});
