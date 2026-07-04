/**
 * Report p_true tier coverage from DB + Redis lookup sample.
 *
 * Usage:
 *   npm run report:pipeline-coverage
 *   npm run report:pipeline-coverage -- --limit 1000 --redis-sample 100
 */
import { loadEnvFiles } from "./loadEnv";

loadEnvFiles();

import { getDb, isDatabaseEnabled } from "../lib/crossmarket/store/db";
import {
  collectPipelineCoverageReport,
  formatPipelineCoverageSummary,
} from "../lib/evPipeline/pipelineCoverage";

function parseArgs(argv: string[]) {
  return {
    rowLimit: (() => {
      const idx = argv.indexOf("--limit");
      if (idx === -1) return 5000;
      const parsed = Number(argv[idx + 1]);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
    })(),
    redisSample: (() => {
      const idx = argv.indexOf("--redis-sample");
      if (idx === -1) return 200;
      const parsed = Number(argv[idx + 1]);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
    })(),
  };
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL is not configured.");
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const db = getDb();
  const report = await collectPipelineCoverageReport(db, {
    rowLimit: args.rowLimit,
    redisSampleSize: args.redisSample,
  });

  console.log(`\n${formatPipelineCoverageSummary(report)}\n`);

  const total = report.latestPTrueCount;
  if (total > 0) {
    console.log("Tier breakdown (% of latest p_true rows):");
    for (const [source, count] of Object.entries(report.bySource).sort(
      (a, b) => b[1] - a[1]
    )) {
      const pct = ((count / total) * 100).toFixed(1);
      console.log(`  ${source.padEnd(22)} ${String(count).padStart(5)}  (${pct}%)`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
