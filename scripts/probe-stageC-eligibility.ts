#!/usr/bin/env tsx
import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";

async function main(): Promise<void> {
  const db = getDb();
  const summary = await db.execute(sql`
    SELECT 
      (SELECT count(*)::int FROM whale_registry) AS registry_total,
      (SELECT count(*)::int FROM wallet_historical_metrics WHERE metric_version = ${WALLET_METRIC_VERSION}) AS metrics_total,
      (SELECT count(*)::int FROM wallet_historical_metrics WHERE metric_version = ${WALLET_METRIC_VERSION} AND credibility_metrics_valid = true) AS metrics_valid,
      (SELECT count(*)::int FROM wallet_historical_metrics WHERE metric_version = ${WALLET_METRIC_VERSION} AND credibility_metrics_valid = true AND completed_positions >= 10) AS eligible_10
  `);
  const registryStrata = await db.execute(sql`
    SELECT
      CASE
        WHEN hydration_status != 'complete' THEN 'unknown_hydration'
        WHEN resolved_bets_count = 50 THEN 'capped_50'
        WHEN resolved_bets_count >= 10 THEN 'medium_high'
        WHEN resolved_bets_count > 0 THEN 'low'
        ELSE 'zero'
      END AS stratum,
      count(*)::int AS c
    FROM whale_registry
    GROUP BY 1
    ORDER BY c DESC
  `);
  console.log(JSON.stringify({ summary: summary.rows[0], registryStrata: registryStrata.rows }, null, 2));
}

void main();
