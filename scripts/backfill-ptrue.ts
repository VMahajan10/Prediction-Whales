/**
 * Backfill p_true + trade EV lookups for all DB mappings.
 *
 * Usage:
 *   npm run backfill:ptrue
 *   npm run backfill:ptrue -- --dry-run
 *   npm run backfill:ptrue -- --limit 500
 *   npm run backfill:ptrue -- --flush-stale
 *   npm run backfill:ptrue -- --flush-all-lookups
 *
 * Requires DATABASE_URL. Redis optional (recommended for cache refresh).
 */
import { loadEnvFiles } from "./loadEnv";

loadEnvFiles();

import { getDb, isDatabaseEnabled } from "../lib/crossmarket/store/db";
import { backfillMappedPTrue } from "../lib/evPipeline/computeMappedEv";
import { initGlobalLocalEvCache } from "../lib/evPipeline/redisCache";
import {
  collectPipelineCoverageReport,
  formatPipelineCoverageSummary,
} from "../lib/evPipeline/pipelineCoverage";

function parseArgs(argv: string[]) {
  return {
    dryRun: argv.includes("--dry-run"),
    limit: (() => {
      const idx = argv.indexOf("--limit");
      if (idx === -1) return 5000;
      const raw = argv[idx + 1];
      const parsed = raw ? Number(raw) : NaN;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
    })(),
    flushStale: argv.includes("--flush-stale"),
    flushAllLookups: argv.includes("--flush-all-lookups"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log("\n── p_true backfill ──\n");
  console.log(`  dry-run:          ${args.dryRun}`);
  console.log(`  limit:            ${args.limit}`);
  console.log(`  flush-stale:      ${args.flushStale}`);
  console.log(`  flush-all-lookups:${args.flushAllLookups}`);

  if (!isDatabaseEnabled()) {
    console.error("\nDATABASE_URL is not configured.\n");
    process.exit(1);
  }

  initGlobalLocalEvCache();
  const db = getDb();

  if (args.dryRun) {
    const coverage = await collectPipelineCoverageReport(db, {
      rowLimit: args.limit,
    });
    console.log("\nDry run — current coverage (no writes):\n");
    console.log(formatPipelineCoverageSummary(coverage));
    process.exit(0);
  }

  const started = Date.now();
  const result = await backfillMappedPTrue(db, {
    dbLimit: args.limit,
    flushLookups: args.flushAllLookups
      ? true
      : args.flushStale
        ? "stale-only"
        : false,
  });

  console.log(`\nProcessed mappings: ${result.processed}`);
  if (result.flushed) {
    console.log(
      `Flushed lookups: scanned=${result.flushed.scanned} deleted=${result.flushed.deleted} stale=${result.flushed.stale}`
    );
  }

  const coverage = await collectPipelineCoverageReport(db, {
    rowLimit: args.limit,
  });
  console.log(`\n${formatPipelineCoverageSummary(coverage)}`);
  console.log(`\nDone in ${Date.now() - started}ms\n`);
}

main().catch((err) => {
  console.error(
    "\nBackfill failed:",
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
