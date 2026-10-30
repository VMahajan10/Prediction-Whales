#!/usr/bin/env tsx
/** Validate PF + reconciliation for 20 seeded whale_registry wallets (API-only). */
import "../tests/preload-env";
import { validateWalletPfFromApi } from "@/lib/polymarketDataApi/validateWalletPf";
import { formatProfitFactorValue } from "@/lib/walletProfitFactor";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";

async function randomRegistryWallets(n: number): Promise<string[]> {
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
  const seed = Number(process.env.VALIDATE_PF_SEED ?? "42");
  let rng = seed;
  const rand = () => {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    return rng / 0x100000000;
  };
  while (picked.length < n && pool.length > 0) {
    const i = Math.floor(rand() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

async function main() {
  const wallets = await randomRegistryWallets(20);
  const seed = process.env.VALIDATE_PF_SEED ?? "42";
  console.log(`Random sample (${wallets.length} wallets), seed=${seed}`);
  console.log(wallets.join("\n"));
  console.log("");
  let pass = 0;
  let fail = 0;
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    console.log(`[${i + 1}/${wallets.length}] ${wallet.slice(0, 10)}…`);
    const row = await validateWalletPfFromApi(wallet);
    const ok = row.reconciliationPassed && row.statsVerified;
    if (ok) pass++;
    else fail++;
    console.log(
      [
        `closed=${row.closedCount}`,
        `PF=${formatProfitFactorValue(row.profitFactor)}`,
        `gap=${row.reconciliationGapPct?.toFixed(1) ?? "n/a"}%`,
        ok ? "PASS" : "FAIL",
      ].join(" | ")
    );
  }
  console.log(`\nPass: ${pass} Fail: ${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
