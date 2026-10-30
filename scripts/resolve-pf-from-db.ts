#!/usr/bin/env tsx
import "../tests/preload-env";
import { resolveWalletProfitFactorStats } from "@/lib/polymarketDataApi/profitFactorService";
import { formatProfitFactorValue } from "@/lib/walletProfitFactor";

const wallet = process.argv[2];
if (!wallet) process.exit(1);

async function main() {
  const s = await resolveWalletProfitFactorStats(wallet, { forceSync: false });
  console.log({
    verified: s.verified,
    PF: formatProfitFactorValue(s.overall?.profitFactor ?? null),
    headline: s.headlineRealizedPnl,
    gapPct: s.reconciliationGapPct,
    closed: s.overall?.positionCount,
    winRate: s.winRatePct,
    wins: s.closedWinCount,
    losses: s.closedLossCount,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
