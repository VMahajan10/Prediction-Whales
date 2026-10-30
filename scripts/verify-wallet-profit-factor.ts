#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { walletPositionLifecycles } from "@/lib/crossmarket/store/schema";
import {
  computeWalletProfitFactorStats,
  formatProfitFactorValue,
  type ProfitFactorPosition,
} from "@/lib/walletProfitFactor";
import { buildWhaleTrackRecordWithPf } from "@/lib/buildWhaleTrackRecordWithPf";
import { traderClosedPositionsForProfitFactor } from "@/lib/traderProfile";

async function topWalletsFromLedger(limit: number): Promise<string[]> {
  if (!isDatabaseEnabled()) return [];
  const db = getDb();
  const rows = await db
    .select({
      wallet: walletPositionLifecycles.walletAddress,
      completed: sql<number>`count(*)::int`,
    })
    .from(walletPositionLifecycles)
    .where(
      sql`${walletPositionLifecycles.metricVersion} = ${WALLET_METRIC_VERSION} AND ${walletPositionLifecycles.completed} = true AND ${walletPositionLifecycles.realizedPnl} is not null`
    )
    .groupBy(walletPositionLifecycles.walletAddress)
    .orderBy(sql`count(*) desc`)
    .limit(limit);
  return rows.map((r) => r.wallet.toLowerCase());
}

function printWalletAudit(
  wallet: string,
  positions: ProfitFactorPosition[],
  source: string
) {
  const stats = computeWalletProfitFactorStats(positions);
  console.log(`\n=== ${wallet} (${source}) ===`);
  console.log(
    `Positions: ${stats.overall.positionCount} | Gross profit: $${stats.overall.grossProfit.toFixed(2)} | Gross loss: $${stats.overall.grossLoss.toFixed(2)} | PF: ${formatProfitFactorValue(stats.overall.profitFactor)}`
  );
  const sample = positions
    .filter((p) => p.realizedPnl !== 0)
    .slice(0, 8);
  for (const p of sample) {
    console.log(
      `  · ${p.realizedPnl >= 0 ? "+" : ""}$${p.realizedPnl.toFixed(2)} — ${p.title?.slice(0, 60) ?? "—"}`
    );
  }
  if (positions.length > sample.length) {
    console.log(`  … and ${positions.length - sample.length} more positions`);
  }
}

async function positionsFromLedger(
  wallet: string
): Promise<ProfitFactorPosition[]> {
  if (!isDatabaseEnabled()) return [];
  const db = getDb();
  const rows = await db
    .select({
      realizedPnl: walletPositionLifecycles.realizedPnl,
      exclusionReason: walletPositionLifecycles.exclusionReason,
    })
    .from(walletPositionLifecycles)
    .where(
      sql`lower(${walletPositionLifecycles.walletAddress}) = ${wallet.toLowerCase()} AND ${walletPositionLifecycles.metricVersion} = ${WALLET_METRIC_VERSION} AND ${walletPositionLifecycles.completed} = true`
    );
  return rows
    .filter((r) => r.realizedPnl != null && !r.exclusionReason)
    .map((r) => ({
      realizedPnl: r.realizedPnl as number,
      title: `lifecycle ${wallet.slice(0, 8)}`,
    }));
}

async function main() {
  const wallets = await topWalletsFromLedger(3);
  if (wallets.length === 0) {
    console.error("No ledger wallets found — set DATABASE_URL and hydrate wallets.");
    process.exit(1);
  }

  for (const wallet of wallets) {
    try {
      const ledgerPositions = await positionsFromLedger(wallet);
      if (ledgerPositions.length > 0) {
        printWalletAudit(
          wallet,
          ledgerPositions,
          `indexed ledger (${ledgerPositions.length} completed lifecycles)`
        );
      }
      const built = await buildWhaleTrackRecordWithPf(wallet);
      const positions = traderClosedPositionsForProfitFactor(
        built.closedPositions
      );
      printWalletAudit(
        wallet,
        positions,
        `Polymarket API (${built.closedPositionsFetched} fetched, cap ${built.closedPositionsApiLimit})`
      );
    } catch (e) {
      console.error(`Failed ${wallet}:`, e);
    }
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
