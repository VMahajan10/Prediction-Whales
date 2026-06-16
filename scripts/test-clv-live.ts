/**
 * Live CLV test on test wallet — run with:
 *   npx tsx scripts/test-clv-live.ts
 */
import { fetchClosedPositions, computeClvStats } from "../lib/polymarket";
import { isEphemeralClosedPosition } from "../lib/polymarket";

const WALLET = "0x5de61030c508fcff55514abb81ec5368713bd677";

async function main() {
  const t0 = Date.now();
  console.log("Wallet:", WALLET);
  console.log("Fetching closed positions...\n");

  const closed = await fetchClosedPositions(WALLET);
  const eligible = closed.filter((p) => !isEphemeralClosedPosition(p));
  const resolved = eligible.filter((p) => p.curPrice === 0 || p.curPrice === 1);

  console.log(`Closed positions: ${closed.length}`);
  console.log(`Eligible (non-ephemeral): ${eligible.length}`);
  console.log(`Resolved (curPrice 0/1): ${resolved.length}\n`);

  console.log("Computing CLV stats (CLOB fetches, concurrency 8)...\n");
  const stats = await computeClvStats(eligible);

  console.log("=== AGGREGATE ===");
  console.log(`Coverage: ${stats.coverage} of ${stats.totalClosed} closed bets`);
  console.log(`Has enough coverage (≥${stats.coverageFloor}): ${stats.hasEnoughCoverage}`);
  if (stats.avgClv != null) {
    console.log(`Avg CLV (unweighted): ${stats.avgClv >= 0 ? "+" : ""}${(stats.avgClv * 100).toFixed(1)}¢`);
  }
  if (stats.showWeighted && stats.weightedClv != null) {
    console.log(`Stake-weighted CLV: ${stats.weightedClv >= 0 ? "+" : ""}${(stats.weightedClv * 100).toFixed(1)}¢`);
  }
  console.log(`Total EV captured: ${stats.totalEvDollars >= 0 ? "+" : ""}$${stats.totalEvDollars.toFixed(2)}`);
  console.log(`Avg EV per bet: ${stats.avgEvPerBet >= 0 ? "+" : ""}$${stats.avgEvPerBet.toFixed(2)}`);
  console.log(`Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  console.log("=== PER-POSITION ===");
  const positions = stats.positions ?? [];
  const valid = positions.filter((p) => p.valid);
  const excluded = positions.filter((p) => !p.valid);

  if (valid.length) {
    console.log("\nINCLUDED:");
    for (const p of valid) {
      const clvCents = (p.clv! * 100).toFixed(1);
      console.log(
        `  [${p.clv! >= 0 ? "+" : ""}${clvCents}¢] entry=${p.avgPrice.toFixed(3)} close=${p.closingLine!.toFixed(3)} fresh=${p.freshnessHours!.toFixed(1)}h | ${p.title.slice(0, 50)}`
      );
    }
  }

  if (excluded.length) {
    console.log("\nEXCLUDED:");
    const byReason: Record<string, number> = {};
    for (const p of excluded) {
      const r = p.reason ?? "unknown";
      byReason[r] = (byReason[r] ?? 0) + 1;
    }
    console.log("  By reason:", byReason);
    for (const p of excluded.slice(0, 8)) {
      console.log(
        `  [${p.reason}] entry=${p.avgPrice.toFixed(3)} settle=${p.settlement} | ${p.title.slice(0, 50)}`
      );
    }
    if (excluded.length > 8) console.log(`  ... and ${excluded.length - 8} more`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
