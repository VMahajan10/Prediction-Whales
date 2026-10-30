#!/usr/bin/env tsx
import "../tests/preload-env";
import { validateWalletPfFromApi } from "@/lib/polymarketDataApi/validateWalletPf";
import { formatProfitFactorValue } from "@/lib/walletProfitFactor";

const wallet = process.argv[2];
if (!wallet) {
  console.error("Usage: quick-pf-single-wallet.ts <wallet>");
  process.exit(1);
}

async function main() {
  const row = await validateWalletPfFromApi(wallet);
  console.log({
    wallet: row.wallet,
    closed: row.closedCount,
    PF: formatProfitFactorValue(row.profitFactor),
    sum: Math.round(row.positionsSumClosedRealized),
    headline: Math.round(row.headlineRealizedPnl ?? 0),
    gapPct: row.reconciliationGapPct?.toFixed(2),
    pass: row.reconciliationPassed && row.statsVerified,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
