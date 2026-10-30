#!/usr/bin/env tsx
/** Current registry + verified PF summary from DB (no API sync). */
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { getPrisma, isPrismaEnabled } from "@/lib/prisma";
import { resolveWalletProfitFactorStats } from "@/lib/polymarketDataApi/profitFactorService";

async function main() {
  if (!isDatabaseEnabled() || !isPrismaEnabled()) {
    console.error("DATABASE_URL and Prisma required");
    process.exit(1);
  }
  const prisma = getPrisma();
  if (!prisma) process.exit(1);

  const registryTotal = await prisma.whaleRegistry.count();
  const db = getDb();
  const stateRes = await db.execute(sql`
    SELECT
      COUNT(*)::int AS in_sync_table,
      COUNT(*) FILTER (WHERE reconciliation_passed)::int AS verified
    FROM wallet_api_sync_state
  `);
  const stateRow = stateRes.rows[0] as {
    in_sync_table: number;
    verified: number;
  };

  let pf12 = 0;
  let pf15 = 0;
  const verifiedWallets = await db.execute(sql`
    SELECT wallet_address FROM wallet_api_sync_state WHERE reconciliation_passed = true
  `);
  for (const row of verifiedWallets.rows as { wallet_address: string }[]) {
    const stats = await resolveWalletProfitFactorStats(row.wallet_address, {
      forceSync: false,
    });
    if (!stats.verified || !stats.overall) continue;
    const n = stats.overall.positionCount;
    const pf = stats.overall.profitFactor;
    if (n < 30) continue;
    if (pf != null && pf >= 1.2) pf12++;
    if (pf != null && pf >= 1.5) pf15++;
  }

  console.log(
    JSON.stringify(
      {
        registryTotal,
        syncStateRows: stateRow.in_sync_table,
        verifiedCount: stateRow.verified,
        verifiedPfGte12Min30Positions: pf12,
        verifiedPfGte15Min30Positions: pf15,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
