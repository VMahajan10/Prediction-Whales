#!/usr/bin/env tsx
import "../tests/preload-env";
import { fetchAllV2PositionsForStatus } from "@/lib/polymarketDataApi/positions";
import {
  sumReconciliationPnl,
  sumReconciliationPnlAvoidDoubleCount,
} from "@/lib/polymarketDataApi/positionPnlRollup";
import {
  reconciliationGapPercent,
  reconciliationPasses,
} from "@/lib/polymarketDataApi/reconciliation";
import { fetchV2HeadlineRealizedPnl } from "@/lib/polymarketDataApi/userPnl";

const WALLETS = [
  "0x40b96182a35fbe3c2bb4162e036ecf0c786db002",
  "0x34a1eed3f6bb10dd2f99b79cb4e8ca8749ae7622",
  "0x74f6d39911e21cdcaeff31ba02ea757d4646c31c",
  "0x1e29756e7b63827cafb9cd39caa55eee77e5740f",
  "0x9e3ed7b661a903fc97afcf49e0f014ebe869f882",
  "0xad529df14c293d77984a0137990a1441b25211ac",
];

async function main() {
  console.log("wallet | oldGap% | newFull% | newDc% | old | newFull | newDc");
  for (const wallet of WALLETS) {
    const closed = await fetchAllV2PositionsForStatus(wallet, "CLOSED");
    const open = await fetchAllV2PositionsForStatus(wallet, "OPEN");
    const red = await fetchAllV2PositionsForStatus(wallet, "REDEEMABLE");
    const all = [...closed, ...open, ...red];
    const headline = await fetchV2HeadlineRealizedPnl(wallet);
    const old = closed.reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0);
    const neu = sumReconciliationPnl(all);
    const neuDc = sumReconciliationPnlAvoidDoubleCount(all);
    const og = reconciliationGapPercent(old, headline!);
    const ng = reconciliationGapPercent(neu, headline!);
    const nd = reconciliationGapPercent(neuDc, headline!);
    console.log(
      [
        wallet.slice(0, 10),
        og?.toFixed(1),
        ng?.toFixed(1),
        nd?.toFixed(1),
        reconciliationPasses(og) ? "P" : "F",
        reconciliationPasses(ng) ? "P" : "F",
        reconciliationPasses(nd) ? "P" : "F",
      ].join(" | ")
    );
  }
  console.log("\n(Skipping 0x0346afae… — 100k+ CLOSED; OR-only sum_total_pnl ≈ -6.51M on 39,883 resolved rows)");
}

main();
