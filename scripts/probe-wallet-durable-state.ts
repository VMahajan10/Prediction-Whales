#!/usr/bin/env tsx
import "./preload-env";
import { sql, eq, and } from "drizzle-orm";
import { getDb, isDatabaseEnabled } from "@/lib/crossmarket/store/db";
import {
  walletShadowBatchStatus,
  walletHistoryCoverage,
  walletHistoricalMetrics,
} from "@/lib/crossmarket/store/schema";
import { readBatchStatusJournal } from "@/lib/walletLedger/indexed/shadow/batchStatusJournal";
import { readDeferAttempts } from "@/lib/walletLedger/indexed/shadow/batchScheduling";

const wallet = (
  process.argv[2] ?? "0x84cfffc3f16dcc353094de30d4a45226eccd2f63"
).toLowerCase();
const batchId = process.argv[3] ?? "phase2e2-stageC-v1";

async function main(): Promise<void> {
  const journal = readBatchStatusJournal().filter(
    (entry) => entry.wallet === wallet && entry.batchId === batchId
  );

  if (!isDatabaseEnabled()) {
    console.log(JSON.stringify({ wallet, batchId, journal, db: "disabled" }, null, 2));
    return;
  }

  const db = getDb();
  const statusRows = await db
    .select()
    .from(walletShadowBatchStatus)
    .where(
      and(
        eq(walletShadowBatchStatus.batchId, batchId),
        eq(walletShadowBatchStatus.walletAddress, wallet)
      )
    )
    .limit(1);
  const coverageRows = await db
    .select()
    .from(walletHistoryCoverage)
    .where(eq(walletHistoryCoverage.walletAddress, wallet))
    .limit(1);
  const metricsRows = await db
    .select()
    .from(walletHistoricalMetrics)
    .where(eq(walletHistoricalMetrics.walletAddress, wallet))
    .limit(1);
  const eventCount = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from wallet_ledger_events where wallet_address = ${wallet}`
  );
  const lifecycleCount = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from wallet_position_lifecycles where wallet_address = ${wallet}`
  );

  const status = statusRows[0] ?? null;
  console.log(
    JSON.stringify(
      {
        wallet,
        batchId,
        batchStatus: status
          ? {
              status: status.status,
              errorMessage: status.errorMessage,
              deferAttempts: readDeferAttempts(status.performance),
              performance: status.performance,
              updatedAt: status.updatedAt?.toISOString(),
            }
          : null,
        journalEntries: journal.map((entry) => ({
          desiredStatus: entry.desiredStatus,
          error: entry.error,
          timestamp: entry.timestamp,
          deferAttempts: readDeferAttempts(entry.performance),
        })),
        coverage: coverageRows[0] ?? null,
        metrics: metricsRows[0]
          ? {
              metricVersion: metricsRows[0].metricVersion,
              credibilityMetricsValid: metricsRows[0].credibilityMetricsValid,
              completedPositions: metricsRows[0].completedPositions,
            }
          : null,
        eventCount: eventCount.rows[0]?.n ?? 0,
        lifecycleCount: lifecycleCount.rows[0]?.n ?? 0,
      },
      null,
      2
    )
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
