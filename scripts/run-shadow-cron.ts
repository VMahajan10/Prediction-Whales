/**
 * Single-run shadow cron for CI (GitHub Actions) and manual invocation.
 *
 * Usage:
 *   npx tsx scripts/run-shadow-cron.ts
 */
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { loadEnvFiles } from "./loadEnv";
import { runXAgentShadowPipeline } from "../lib/x-agent/runShadowPipeline";
import { disconnectPrisma } from "../lib/prisma";

loadEnvFiles();

const connectionString = process.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString }) : null;
const adapter = pool ? new PrismaPg(pool) : null;
const prisma = adapter ? new PrismaClient({ adapter }) : null;

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

async function runCron(): Promise<void> {
  const startedAt = Date.now();

  try {
    console.log(
      `[${formatTimestamp()}] [Shadow Cron] Starting pipeline run...`
    );

    const result = await runXAgentShadowPipeline();

    let pendingQueue: number | null = null;
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
      !result.error && result.whalesFailed === 0 ? "ok" : "partial";

    console.log(
      `[${formatTimestamp()}] [Shadow Cron] Pipeline run complete. | duration=${formatDuration(durationMs)} | evPipeline=${result.evPipelineOk ? "ok" : "error"} | whalesFetched=${result.whalesFetched} | whalesProcessed=${result.whalesProcessed} | whalesFailed=${result.whalesFailed} | pendingXPostQueue=${pendingLabel} | status=${status}${result.error ? ` | error=${result.error}` : ""}`
    );
  } catch (error) {
    console.error("[Shadow Cron] Error executing pipeline:", error);
    process.exitCode = 1;
  } finally {
    if (prisma) {
      await prisma.$disconnect();
    }
    if (pool) {
      await pool.end();
    }
    await disconnectPrisma();
    process.exit(process.exitCode ?? 0);
  }
}

void runCron();
