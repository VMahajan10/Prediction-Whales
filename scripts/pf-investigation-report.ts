#!/usr/bin/env tsx
/**
 * Full PF investigation report (tasks 1–4, 6–8). Does not change production gate.
 */
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { fetchAllV2PositionsForStatus } from "@/lib/polymarketDataApi/positions";
import {
  isResolvedNonClosedPosition,
  profitFactorPnlFromRow,
  summarizeResolvedOpenRedeemable,
  sumReconciliationPnl,
  sumReconciliationPnlAvoidDoubleCount,
} from "@/lib/polymarketDataApi/positionPnlRollup";
import {
  reconciliationGapPercent,
  reconciliationPasses,
} from "@/lib/polymarketDataApi/reconciliation";
import { validateWalletPfFromApi } from "@/lib/polymarketDataApi/validateWalletPf";
import { fetchV2HeadlineRealizedPnl } from "@/lib/polymarketDataApi/userPnl";
import {
  computeWalletProfitFactorStats,
  DEFAULT_MIN_POSITION_COUNT,
  DEFAULT_MIN_PROFIT_FACTOR,
  formatProfitFactorValue,
} from "@/lib/walletProfitFactor";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";

const FAILING_FIVE = [
  "0x40b96182a35fbe3c2bb4162e036ecf0c786db002",
  "0x34a1eed3f6bb10dd2f99b79cb4e8ca8749ae7622",
  "0x0346afae2603313d2bbee96b628536c8cbe352a5",
  "0x74f6d39911e21cdcaeff31ba02ea757d4646c31c",
  "0x1e29756e7b63827cafb9cd39caa55eee77e5740f",
];
const W2 = "0x9e3ed7b661a903fc97afcf49e0f014ebe869f882";
const W3 = "0xad529df14c293d77984a0137990a1441b25211ac";

function winRateFromPnls(pnls: number[], countZerosAsLoss = false) {
  let w = 0;
  let l = 0;
  let z = 0;
  for (const p of pnls) {
    if (p > 0) w++;
    else if (p < 0) l++;
    else {
      z++;
      if (countZerosAsLoss) l++;
    }
  }
  const d = w + l;
  return { w, l, z, pct: d > 0 ? (w / d) * 100 : null };
}

async function seededWallets(n: number): Promise<string[]> {
  if (!isPrismaEnabled()) return [];
  const prisma = getPrisma();
  if (!prisma) return [];
  const rows = await prisma.whaleRegistry.findMany({
    where: { hydrationStatus: "complete" },
    select: { walletAddress: true },
    take: 300,
  });
  const pool = rows.map((r) => r.walletAddress.toLowerCase());
  const picked: string[] = [];
  let rng = Number(process.env.VALIDATE_PF_SEED ?? "42");
  const rand = () => {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    return rng / 0x100000000;
  };
  while (picked.length < n && pool.length > 0) {
    picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return picked;
}

async function gapRow(wallet: string) {
  const closed = await fetchAllV2PositionsForStatus(wallet, "CLOSED");
  const open = await fetchAllV2PositionsForStatus(wallet, "OPEN");
  const red = await fetchAllV2PositionsForStatus(wallet, "REDEEMABLE");
  const all = [...closed, ...open, ...red];
  const headline = await fetchV2HeadlineRealizedPnl(wallet);
  const oldSum = closed.reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0);
  const newSum = sumReconciliationPnl(all);
  const newSumDc = sumReconciliationPnlAvoidDoubleCount(all);
  const oldGap = headline != null ? reconciliationGapPercent(oldSum, headline) : null;
  const newGap = headline != null ? reconciliationGapPercent(newSum, headline) : null;
  const newGapDc =
    headline != null ? reconciliationGapPercent(newSumDc, headline) : null;
  return { wallet, oldGap, newGap, newGapDc, oldPass: reconciliationPasses(oldGap), newPass: reconciliationPasses(newGap), newPassDc: reconciliationPasses(newGapDc) };
}

async function main() {
  console.log("## 1) Resolved OPEN/REDEEMABLE (5 failing wallets)\n");
  for (const wallet of FAILING_FIVE) {
    const open = await fetchAllV2PositionsForStatus(wallet, "OPEN");
    const red = await fetchAllV2PositionsForStatus(wallet, "REDEEMABLE");
    const summary = summarizeResolvedOpenRedeemable([...open, ...red]);
    console.log(wallet);
    console.log(`  OPEN=${open.length} REDEEMABLE=${red.length}`);
    console.log(
      `  resolved on settled markets: count=${summary.count} sum_total_pnl=${summary.sumTotalPnl.toFixed(2)} sum_realized_pnl=${summary.sumRealizedPnl.toFixed(2)} avg_prices=${summary.samplePrices.join(",")}`
    );
    const resolved = [...open, ...red].filter((r) =>
      isResolvedNonClosedPosition(r)
    );
    if (resolved[0]) {
      const r = resolved[0];
      console.log(
        `  example: price=${r.current_price} total_pnl=${r.total_pnl} realized=${r.realized_pnl} status=${r.status}`
      );
    }
    console.log("");
  }

  console.log("## 3) Gap before/after (extended rollup + double-count-safe variant)\n");
  for (const wallet of [...FAILING_FIVE, W2, W3]) {
    const r = await gapRow(wallet);
    console.log(
      `${r.wallet.slice(0, 10)}… old=${r.oldGap?.toFixed(1)}% ${r.oldPass ? "PASS" : "FAIL"} | full=${r.newGap?.toFixed(1)}% ${r.newPass ? "PASS" : "FAIL"} | dc=${r.newGapDc?.toFixed(1)}% ${r.newPassDc ? "PASS" : "FAIL"}`
    );
  }

  console.log("\n## 6) Wallet 3 win rate (CLOSED realized_pnl pushes excluded)\n");
  const closed3 = await fetchAllV2PositionsForStatus(W3, "CLOSED");
  const pnls = closed3.map((r) => Number(r.realized_pnl ?? 0));
  const correct = winRateFromPnls(pnls, false);
  const wrong = winRateFromPnls(pnls, true);
  console.log(
    `Correct (exclude zero): ${correct.w}W ${correct.l}L ${correct.z}Z → ${correct.pct?.toFixed(2)}%`
  );
  console.log(
    `If zeros counted as losses: ${wrong.w}W ${wrong.l}L → ${wrong.pct?.toFixed(2)}%`
  );

  if (isDatabaseEnabled()) {
    console.log("\n## 7) Wallet 3 category tags (from DB cache)\n");
    const db = getDb();
    for (const cat of ["NFL", "POLITICS"]) {
      const r = await db.execute(sql`
        SELECT title, category_label, realized_pnl, status
        FROM wallet_api_positions
        WHERE lower(wallet_address) = lower(${W3})
          AND category_label = ${cat}
        LIMIT 10
      `);
      console.log(`### ${cat}`);
      for (const row of r.rows as { title: string; category_label: string }[]) {
        console.log(`  - [${row.category_label}] ${row.title?.slice(0, 72)}`);
      }
    }
  }

  console.log("\n## 4 & 8) 20-wallet sample pass rate + filters (API validation, CLOSED-only gate)\n");
  const sample = await seededWallets(20);
  let pass = 0;
  let fail = 0;
  const verified: Awaited<ReturnType<typeof validateWalletPfFromApi>>[] = [];
  for (let i = 0; i < sample.length; i++) {
    const w = sample[i];
    process.stderr.write(`[${i + 1}/20] ${w.slice(0, 10)}…\n`);
    const row = await validateWalletPfFromApi(w);
    if (row.reconciliationPassed && row.statsVerified) {
      pass++;
      verified.push(row);
    } else fail++;
  }
  console.log(`Pass rate (unchanged gate): ${pass}/${sample.length} (${((pass / sample.length) * 100).toFixed(0)}%)`);

  let passPf15 = 0;
  let passPf12 = 0;
  for (const v of verified) {
    const pf = v.profitFactor ?? 0;
    const n = v.closedCount;
    if (n >= DEFAULT_MIN_POSITION_COUNT && pf >= DEFAULT_MIN_PROFIT_FACTOR)
      passPf15++;
    if (n >= DEFAULT_MIN_POSITION_COUNT && pf >= 1.2) passPf12++;
  }
  console.log(
    `Verified wallets passing default filter (PF>=${DEFAULT_MIN_PROFIT_FACTOR}, n>=${DEFAULT_MIN_POSITION_COUNT}): ${passPf15}/${verified.length}`
  );
  console.log(
    `Verified wallets passing PF>=1.2 and n>=${DEFAULT_MIN_POSITION_COUNT}: ${passPf12}/${verified.length}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
