#!/usr/bin/env tsx
import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";

async function main(): Promise<void> {
  const db = getDb();
  const batches = await db.execute(sql`
    SELECT batch_id, status, count(*)::int c
    FROM wallet_shadow_batch_status
    GROUP BY batch_id, status
    ORDER BY batch_id, status
  `);
  const overlap = await db.execute(sql`
    SELECT m.wallet_address, m.credibility_metrics_valid, m.completed_positions, m.history_validity
    FROM wallet_historical_metrics m
    WHERE m.metric_version = ${WALLET_METRIC_VERSION}
    ORDER BY m.completed_positions DESC
  `);
  console.log(JSON.stringify({ batches: batches.rows, metrics: overlap.rows }, null, 2));
}

void main();
