/**
 * Report arbitrage finder scan coverage (order-book health + lock rates).
 *
 * Usage:
 *   npm run report:arb-coverage
 *   npm run report:arb-coverage -- --limit 500
 */
import { loadEnvFiles } from "./loadEnv";

loadEnvFiles();

import { isDatabaseEnabled } from "../lib/crossmarket/store/db";
import {
  collectArbitrageScanCoverage,
  formatArbitrageScanCoverageSummary,
} from "../lib/arbitrageFinder/observability/scanCoverage";

function parseArgs(argv: string[]) {
  return {
    mappingLimit: (() => {
      const idx = argv.indexOf("--limit");
      if (idx === -1) return 250;
      const parsed = Number(argv[idx + 1]);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 250;
    })(),
  };
}

async function main(): Promise<void> {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL is not configured.");
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const report = await collectArbitrageScanCoverage({
    mappingLimit: args.mappingLimit,
    recordMeta: true,
    logSummary: false,
  });

  console.log(`\n${formatArbitrageScanCoverageSummary(report)}\n`);

  if (report.scannedPairs > 0) {
    console.log("Reject reason breakdown:");
    for (const [reason, count] of Object.entries(report.byRejectReason).sort(
      (a, b) => b[1] - a[1]
    )) {
      const pct = ((count / report.scannedPairs) * 100).toFixed(1);
      console.log(`  ${reason.padEnd(22)} ${String(count).padStart(5)}  (${pct}%)`);
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
