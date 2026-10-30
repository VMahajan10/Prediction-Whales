#!/usr/bin/env tsx
/**
 * Step 1: CLOSED position realized_pnl sign counts for wallet 3.
 */
import { fetchAllV2PositionsForStatus } from "@/lib/polymarketDataApi/positions";

const WALLET_3 = "0xad529df14c293d77984a0137990a1441b25211ac";

async function main() {
  const rows = await fetchAllV2PositionsForStatus(WALLET_3, "CLOSED");
  let positive = 0;
  let negative = 0;
  let zero = 0;
  let negativeNotRedeemable = 0;
  const negativeSamples: {
    realized_pnl: number;
    redeemable: boolean;
    title: string;
  }[] = [];

  for (const r of rows) {
    const rp = Number(r.realized_pnl ?? 0);
    if (rp > 0) positive++;
    else if (rp < 0) {
      negative++;
      if (!r.redeemable) negativeNotRedeemable++;
      if (negativeSamples.length < 5) {
        negativeSamples.push({
          realized_pnl: rp,
          redeemable: Boolean(r.redeemable),
          title: (r.title ?? "").slice(0, 72),
        });
      }
    } else zero++;
  }

  console.log("Wallet 3 CLOSED positions (API v2):");
  console.log({
    total: rows.length,
    positive,
    negative,
    zero,
    negativeNotRedeemable,
  });
  console.log("\nSample losing CLOSED positions (resolved losers may be redeemable=false):");
  for (const s of negativeSamples) console.log(s);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
