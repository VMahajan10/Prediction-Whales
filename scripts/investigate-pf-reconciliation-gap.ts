#!/usr/bin/env tsx
/**
 * Investigate CLOSED-only vs extended rollup reconciliation gaps.
 */
import "../tests/preload-env";
import { fetchAllV2PositionsForStatus } from "@/lib/polymarketDataApi/positions";
import {
  reconciliationGapPercent,
  reconciliationPasses,
} from "@/lib/polymarketDataApi/reconciliation";
import {
  isResolvedNonClosedPosition,
  sumReconciliationPnl,
  summarizeResolvedOpenRedeemable,
} from "@/lib/polymarketDataApi/positionPnlRollup";
import { fetchV2HeadlineRealizedPnl } from "@/lib/polymarketDataApi/userPnl";
import {
  computeWalletProfitFactorStats,
  formatProfitFactorValue,
  type ProfitFactorPosition,
} from "@/lib/walletProfitFactor";
import { profitFactorPnlFromRow } from "@/lib/polymarketDataApi/positionPnlRollup";

const FAILING_FIVE = [
  "0x40b96182a35fbe3c2bb4162e036ecf0c786db002",
  "0x34a1eed3f6bb10dd2f99b79cb4e8ca8749ae7622",
  "0x0346afae2603313d2bbee96b628536c8cbe352a5",
  "0x74f6d39911e21cdcaeff31ba02ea757d4646c31c",
  "0x1e29756e7b63827cafb9cd39caa55eee77e5740f",
];

const W2 = "0x9e3ed7b661a903fc97afcf49e0f014ebe869f882";
const W3 = "0xad529df14c293d77984a0137990a1441b25211ac";

async function loadAllPositions(wallet: string) {
  const closed = await fetchAllV2PositionsForStatus(wallet, "CLOSED");
  const open = await fetchAllV2PositionsForStatus(wallet, "OPEN");
  const redeemable = await fetchAllV2PositionsForStatus(wallet, "REDEEMABLE");
  return [...closed, ...open, ...redeemable];
}

function closedOnlySum(closed: Awaited<ReturnType<typeof fetchAllV2PositionsForStatus>>) {
  return closed.reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0);
}

function pfFromRows(all: ReturnType<typeof loadAllPositions> extends Promise<infer T> ? T : never) {
  const pnls: ProfitFactorPosition[] = [];
  for (const row of all) {
    const pnl = profitFactorPnlFromRow(row);
    if (pnl == null) continue;
    pnls.push({
      realizedPnl: pnl,
      hasReliableTitle: false,
      hasReliableCategory: false,
    });
  }
  return computeWalletProfitFactorStats(pnls);
}

async function reportGap(wallet: string) {
  const closed = await fetchAllV2PositionsForStatus(wallet, "CLOSED");
  const open = await fetchAllV2PositionsForStatus(wallet, "OPEN");
  const redeemable = await fetchAllV2PositionsForStatus(wallet, "REDEEMABLE");
  const all = [...closed, ...open, ...redeemable];
  const headline = await fetchV2HeadlineRealizedPnl(wallet);
  const oldSum = closedOnlySum(closed);
  const newSum = sumReconciliationPnl(all);
  const oldGap = headline != null ? reconciliationGapPercent(oldSum, headline) : null;
  const newGap = headline != null ? reconciliationGapPercent(newSum, headline) : null;
  const pf = pfFromRows(all);
  return {
    wallet,
    closed: closed.length,
    oldSum,
    newSum,
    headline,
    oldGap,
    newGap,
    oldPass: reconciliationPasses(oldGap),
    newPass: reconciliationPasses(newGap),
    PF: formatProfitFactorValue(pf.overall?.profitFactor ?? null),
    pfPositions: pf.overall?.positionCount ?? 0,
  };
}

async function main() {
  console.log("=== 1) Resolved OPEN/REDEEMABLE on 5 failing wallets ===\n");
  for (const wallet of FAILING_FIVE) {
    const open = await fetchAllV2PositionsForStatus(wallet, "OPEN");
    const redeemable = await fetchAllV2PositionsForStatus(wallet, "REDEEMABLE");
    const combined = [...open, ...redeemable];
    const resolved = combined.filter((r) => isResolvedNonClosedPosition(r));
    const summary = summarizeResolvedOpenRedeemable(combined);
    console.log(wallet.slice(0, 12) + "…");
    console.log("  OPEN", open.length, "REDEEMABLE", redeemable.length);
    console.log("  resolved non-closed:", summary.count);
    console.log(
      "  sum total_pnl:",
      summary.sumTotalPnl.toFixed(2),
      "sum realized_pnl:",
      summary.sumRealizedPnl.toFixed(2),
      "sum current_value:",
      summary.sumCurrentValue.toFixed(2)
    );
    if (resolved.length > 0) {
      const sample = resolved.slice(0, 3);
      for (const r of sample) {
        console.log(
          `    sample: price=${r.current_price} total_pnl=${r.total_pnl} realized=${r.realized_pnl} status=${r.status} ${(r.title ?? "").slice(0, 50)}`
        );
      }
    }
    console.log("");
  }

  console.log("=== 3) Gap before/after extended rollup (5 fail + W2 + W3) ===\n");
  const targets = [...FAILING_FIVE, W2, W3];
  for (const wallet of targets) {
    const r = await reportGap(wallet);
    console.log(
      [
        r.wallet.slice(0, 10) + "…",
        `closed=${r.closed}`,
        `oldGap=${r.oldGap?.toFixed(1) ?? "n/a"}%`,
        r.oldPass ? "OLD_PASS" : "OLD_FAIL",
        `newGap=${r.newGap?.toFixed(1) ?? "n/a"}%`,
        r.newPass ? "NEW_PASS" : "NEW_FAIL",
        `PF=${r.PF}`,
        `pfN=${r.pfPositions}`,
      ].join(" | ")
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
