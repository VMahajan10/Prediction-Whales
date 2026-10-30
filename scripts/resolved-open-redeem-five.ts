#!/usr/bin/env tsx
import "../tests/preload-env";
import { fetchAllV2PositionsForStatus } from "@/lib/polymarketDataApi/positions";
import { summarizeResolvedOpenRedeemable } from "@/lib/polymarketDataApi/positionPnlRollup";

const WALLETS = [
  "0x40b96182a35fbe3c2bb4162e036ecf0c786db002",
  "0x34a1eed3f6bb10dd2f99b79cb4e8ca8749ae7622",
  "0x0346afae2603313d2bbee96b628536c8cbe352a5",
  "0x74f6d39911e21cdcaeff31ba02ea757d4646c31c",
  "0x1e29756e7b63827cafb9cd39caa55eee77e5740f",
];

async function main() {
  for (const wallet of WALLETS) {
    const open = await fetchAllV2PositionsForStatus(wallet, "OPEN");
    const red = await fetchAllV2PositionsForStatus(wallet, "REDEEMABLE");
    const s = summarizeResolvedOpenRedeemable([...open, ...red]);
    console.log(wallet);
    console.log(
      JSON.stringify(
        {
          open: open.length,
          redeemable: red.length,
          resolvedCount: s.count,
          sumTotalPnl: s.sumTotalPnl,
          sumRealizedPnl: s.sumRealizedPnl,
          sumCurrentValue: s.sumCurrentValue,
        },
        null,
        2
      )
    );
  }
}

main();
