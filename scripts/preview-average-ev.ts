/**
 * Print resolved Average EV display for two wallets (CLV vs fallback).
 */
import { buildWhaleTrackRecord } from "../lib/polymarket";
import { resolveAverageEvDisplay } from "../lib/averageEvDisplay";

const WALLETS = {
  clv: "0x5de61030c508fcff55514abb81ec5368713bd677",
  fallback: "0xe64bab48399e612bf7a585eacc9b2e9c2f31ce05",
};

async function main() {
  for (const [label, wallet] of Object.entries(WALLETS)) {
    const result = await buildWhaleTrackRecord(wallet);
    const display = resolveAverageEvDisplay(
      result.clvStats,
      result.trackRecord
    );
    console.log(`\n=== ${label.toUpperCase()} ${wallet.slice(0, 10)}… ===`);
    console.log(JSON.stringify(display, null, 2));
    console.log(
      `coverage: ${result.clvStats.coverage}/${result.clvStats.totalClosed}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
