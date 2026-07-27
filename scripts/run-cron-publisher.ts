/**
 * Minute cron worker for scheduled X posts.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.json scripts/run-cron-publisher.ts
 *   npx tsx --tsconfig tsconfig.json scripts/run-cron-publisher.ts --once
 */
import "./preload-env";
import { runCronPublisher } from "../lib/x-agent/cronPublisher";

const INTERVAL_MS = 60_000;
const runOnce = process.argv.includes("--once");

async function tick(): Promise<void> {
  const started = Date.now();
  console.log(`[cron-publisher] Tick at ${new Date().toISOString()}`);
  await runCronPublisher();
  console.log(`[cron-publisher] Tick complete (${Date.now() - started}ms)`);
}

async function main(): Promise<void> {
  console.log(
    `[cron-publisher] Starting (${runOnce ? "single run" : `every ${INTERVAL_MS / 1000}s`})`
  );

  if (runOnce) {
    await tick();
    return;
  }

  await tick();
  setInterval(() => {
    void tick();
  }, INTERVAL_MS);
}

main().catch((error) => {
  console.error("[cron-publisher] Fatal error:", error);
  process.exit(1);
});
