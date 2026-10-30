#!/usr/bin/env tsx
import "../tests/preload-env";
import { resolveWalletProfitFactorStats } from "@/lib/polymarketDataApi/profitFactorService";
import { fetchClosedPositions } from "@/lib/polymarket";

const wallet =
  process.argv[2]?.toLowerCase() ??
  "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";

async function main() {
  const stats = await resolveWalletProfitFactorStats(wallet);
  const closed = await fetchClosedPositions(wallet);
  const apiPnl = closed.reduce(
    (sum, p) => sum + Number(p.realizedPnl ?? 0),
    0
  );

  console.log(`Wallet: ${wallet}`);
  console.log(
    `Ledger gross profit: $${stats.overall?.grossProfit.toFixed(2) ?? "n/a"}`
  );
  console.log(
    `Ledger gross loss:   $${stats.overall?.grossLoss.toFixed(2) ?? "n/a"}`
  );
  console.log(
    `Ledger net (GP − GL): $${stats.netRealizedPnl?.toFixed(2) ?? "n/a"}`
  );
  console.log(
    `Polymarket closed-positions API sum (${closed.length} rows): $${apiPnl.toFixed(2)}`
  );
  console.log(
    "\nNote: API sum is often truncated/biased; compare ledger net to Polymarket profile PnL manually."
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
