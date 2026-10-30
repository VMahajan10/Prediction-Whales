#!/usr/bin/env tsx
/**
 * Validate API v2 profit factor + reconciliation for wallets 1–3 and random whale_registry sample.
 */
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { fetchAllV2PositionsForStatus } from "@/lib/polymarketDataApi/positions";
import { tallyClosedRealizedPnlSigns } from "@/lib/polymarketDataApi/positionStats";
import { validateWalletPfFromApi } from "@/lib/polymarketDataApi/validateWalletPf";
import { syncWalletApiPositions } from "@/lib/polymarketDataApi/positionsStore";
import { formatProfitFactorValue } from "@/lib/walletProfitFactor";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";

const WALLET_3 = "0xad529df14c293d77984a0137990a1441b25211ac";

/** Wallet 1 has 150k+ CLOSED rows — validate last so smaller wallets print first. */
const WALLETS_123 = [
  "0x9e3ed7b661a903fc97afcf49e0f014ebe869f882",
  WALLET_3,
  "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6",
];

async function randomRegistryWallets(n: number): Promise<string[]> {
  if (!isPrismaEnabled()) return [];
  const prisma = getPrisma();
  if (!prisma) return [];
  const rows = await prisma.whaleRegistry.findMany({
    where: { hydrationStatus: "complete" },
    select: { walletAddress: true },
    take: 200,
  });
  const pool = rows.map((r) => r.walletAddress.toLowerCase());
  const picked: string[] = [];
  const used = new Set(WALLETS_123.map((w) => w.toLowerCase()));
  const seed = Number(process.env.VALIDATE_PF_SEED ?? "42");
  let rng = seed;
  const rand = () => {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    return rng / 0x100000000;
  };
  while (picked.length < n && pool.length > 0) {
    const i = Math.floor(rand() * pool.length);
    const w = pool.splice(i, 1)[0];
    if (used.has(w)) continue;
    used.add(w);
    picked.push(w);
  }
  return picked;
}

async function verifyWallet3ClosedSigns() {
  console.log("Wallet 3 — CLOSED realized_pnl sign check (live API)…");
  const closed = await fetchAllV2PositionsForStatus(WALLET_3, "CLOSED");
  const tally = tallyClosedRealizedPnlSigns(closed);
  console.log(
    `  total=${tally.total} positive=${tally.positive} negative=${tally.negative} zero=${tally.zero}`
  );
  console.log(
    `  negative & not redeemable (resolved losers): ${tally.negativeNotRedeemable}`
  );
  if (tally.negative === 0) {
    console.warn("  WARN: no negative CLOSED positions — unexpected for this wallet");
  }
  console.log("");
}

async function main() {
  if (!isDatabaseEnabled()) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  await verifyWallet3ClosedSigns();

  const random = await randomRegistryWallets(20);
  const wallets = [...WALLETS_123, ...random];
  console.log(`Validating ${wallets.length} wallets...\n`);

  const lines: string[] = [];
  let pass = 0;
  let fail = 0;

  const dbSyncWallets = new Set<string>();
  if (process.argv.includes("--db-sync-wallet3")) {
    dbSyncWallets.add(WALLET_3);
  }
  if (process.argv.includes("--db-sync-all")) {
    for (const w of wallets) dbSyncWallets.add(w);
  }

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    console.log(`[${i + 1}/${wallets.length}] ${wallet.slice(0, 10)}…`);
    const row = await validateWalletPfFromApi(wallet);
    if (dbSyncWallets.has(wallet.toLowerCase())) {
      try {
        await syncWalletApiPositions(wallet, { forceFull: true });
      } catch (err) {
        console.warn(`  DB sync failed for ${wallet.slice(0, 10)}:`, err);
      }
    }
    const ok = row.reconciliationPassed && row.statsVerified;
    if (ok) pass++;
    else fail++;

    lines.push(
      [
        wallet.slice(0, 10) + "…",
        `closed=${row.closedCount}`,
        `PF=${formatProfitFactorValue(row.profitFactor)}`,
        `sum=$${Math.round(row.positionsSumClosedRealized)}`,
        `headline=$${Math.round(row.headlineRealizedPnl ?? 0)}`,
        `gap=${row.reconciliationGapPct?.toFixed(1) ?? "n/a"}%`,
        ok ? "PASS" : "FAIL",
      ].join(" | ")
    );
  }

  console.log(lines.join("\n"));
  console.log(`\nPass: ${pass} Fail: ${fail}`);

  const db = getDb();
  const r = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE realized_pnl > 0) AS pos,
      COUNT(*) FILTER (WHERE realized_pnl < 0) AS neg,
      COUNT(*) FILTER (WHERE realized_pnl = 0) AS zero
    FROM wallet_api_positions
    WHERE lower(wallet_address) = lower(${WALLETS_123[2]})
      AND status = 'CLOSED'
  `);
  console.log("\nWallet 3 CLOSED realized_pnl signs:", r.rows[0]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
