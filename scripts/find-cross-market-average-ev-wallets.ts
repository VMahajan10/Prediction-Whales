import { buildWhaleTrackRecord } from "../lib/polymarket";
import {
  isClvAverageEvComputable,
  isCrossMarketEvComputable,
  resolveAverageEvDisplay,
} from "../lib/averageEvDisplay";

async function main() {
  const res = await fetch(
    "https://data-api.polymarket.com/trades?limit=400"
  );
  const trades = (await res.json()) as Array<{ proxyWallet?: string }>;
  const wallets = Array.from(
    new Set(trades.map((t) => t.proxyWallet).filter(Boolean) as string[])
  ).slice(0, 60);

  const crossWins: unknown[] = [];
  let scanned = 0;
  for (const w of wallets) {
    process.stderr.write(`Scan ${w.slice(0, 10)}…\n`);
    try {
      const r = await buildWhaleTrackRecord(w);
      scanned++;
      const clv = isClvAverageEvComputable(r.clvStats);
      const cross = isCrossMarketEvComputable(r.crossMarketEvStats);
      const display = resolveAverageEvDisplay(
        r.clvStats,
        r.trackRecord,
        { crossMarketEvStats: r.crossMarketEvStats }
      );
      if (!clv && cross) {
        crossWins.push({
          wallet: w,
          mode: display.mode,
          value: display.value,
          cross: `${r.crossMarketEvStats.coverage}/${r.crossMarketEvStats.totalEvaluated}`,
          clv: `${r.clvStats.coverage}/${r.clvStats.totalClosed}`,
        });
      }
    } catch {
      // skip
    }
  }

  console.log(JSON.stringify({ scanned, crossWins }, null, 2));
}

main().catch(console.error);
