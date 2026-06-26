/**
 * Find one wallet with computable CLV and one that falls back to avg return.
 * Usage: npx tsx scripts/find-average-ev-wallets.ts
 */
import {
  buildWhaleTrackRecord,
  fetchClosedPositions,
} from "../lib/polymarket";
import { isClvAverageEvComputable } from "../lib/averageEvDisplay";

const CANDIDATES = [
  "0x5de61030c508fcff55514abb81ec5368713bd677",
  "0x204f72f35326db932158ca75bce219b1a4a77c4f",
  "0xd91e80cf2e7be2e162c6513ce15ff5df1d78f219",
  "0x6a72f61820b26b1fe4d253e7f9b2d6e8b5e5e5e5",
  "0x56687bf4476666b89839e68b7db966a50daf08d0",
  "0x1f2dd1a8c56efb2e0f1e5e5e5e5e5e5e5e5e5e5e5",
];

async function probe(wallet: string) {
  try {
    const closed = await fetchClosedPositions(wallet);
    if (closed.length < 3) return null;
    const result = await buildWhaleTrackRecord(wallet);
    const clvOk = isClvAverageEvComputable(result.clvStats);
    const avgReturn = result.trackRecord?.avgReturnPerBet ?? null;
    return {
      wallet,
      closed: result.trackRecord?.closedCount ?? 0,
      clvOk,
      coverage: result.clvStats.coverage,
      totalClosed: result.clvStats.totalClosed,
      avgClv: result.clvStats.avgClv,
      avgReturn,
      roi: result.trackRecord?.roi,
    };
  } catch {
    return null;
  }
}

async function main() {
  let wallets =
    process.argv.length > 2 ? process.argv.slice(2) : CANDIDATES;

  if (process.argv.includes("--from-feed")) {
    const res = await fetch(
      "https://data-api.polymarket.com/trades?limit=80"
    );
    const trades = (await res.json()) as Array<{ proxyWallet?: string }>;
    wallets = Array.from(
      new Set(trades.map((t) => t.proxyWallet).filter(Boolean) as string[])
    );
  }

  const results = [];
  for (const w of wallets) {
    process.stderr.write(`Probing ${w.slice(0, 10)}…\n`);
    const r = await probe(w);
    if (r) results.push(r);
  }

  const clvWallet = results.find((r) => r.clvOk);
  const fallbackWallet = results.find(
    (r) => !r.clvOk && r.avgReturn != null && r.closed > 0
  );

  console.log(JSON.stringify({ results, clvWallet, fallbackWallet }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
