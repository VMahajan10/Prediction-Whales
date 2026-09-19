#!/usr/bin/env tsx
import "./preload-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { walletHistoricalMetrics, walletShadowBatchStatus } from "@/lib/crossmarket/store/schema";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";
import { STAGE_C_BATCH_ID } from "@/lib/walletLedger/indexed/studyVersion";

async function main(): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(
      join(process.cwd(), "tmp/wallet-history/phase2e2-stageC-cohort.json"),
      "utf8"
    )
  ) as { wallets: Array<{ wallet: string }> };
  const db = getDb();
  const status = await db.execute(sql`
    SELECT status, count(*)::int c FROM wallet_shadow_batch_status
    WHERE batch_id = ${STAGE_C_BATCH_ID}
    GROUP BY status ORDER BY c DESC
  `);
  const metrics = await db.execute(sql`
    SELECT
      count(*)::int total,
      count(*) FILTER (WHERE credibility_metrics_valid = true)::int valid,
      count(*) FILTER (WHERE credibility_metrics_valid = true AND completed_positions >= 10)::int eligible
    FROM wallet_historical_metrics
    WHERE metric_version = ${WALLET_METRIC_VERSION}
  `);
  console.log(JSON.stringify({ batchStatus: status.rows, metrics: metrics.rows[0], cohortSize: manifest.wallets.length }, null, 2));
}

void main();
