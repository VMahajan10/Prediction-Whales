#!/usr/bin/env tsx
import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";

async function main(): Promise<void> {
  const db = getDb();
  const strata = await db.execute(sql`
    SELECT
      CASE
        WHEN hydration_status != 'complete' THEN 'unknown_hydration'
        WHEN resolved_bets_count = 50 THEN 'capped_50'
        WHEN resolved_bets_count >= 10 THEN 'medium_high'
        WHEN resolved_bets_count > 0 THEN 'low'
        ELSE 'zero'
      END AS history_stratum,
      CASE
        WHEN hydration_status != 'complete' THEN 'unknown'
        WHEN resolved_bets_count >= 10 AND avg_ev >= 0.03 THEN 'pass'
        ELSE 'fail'
      END AS prod_gate,
      count(*)::int AS c
    FROM whale_registry
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
  const notAudited = await db.execute(sql`
    SELECT count(*)::int AS c
    FROM whale_registry r
    WHERE NOT EXISTS (
      SELECT 1 FROM wallet_historical_metrics m
      WHERE lower(m.wallet_address) = lower(r.wallet_address)
        AND m.metric_version = ${WALLET_METRIC_VERSION}
    )
  `);
  const auditedEligible = await db.execute(sql`
    SELECT count(*)::int eligible,
      (SELECT count(*)::int FROM wallet_historical_metrics WHERE metric_version = ${WALLET_METRIC_VERSION}) total
    FROM wallet_historical_metrics
    WHERE metric_version = ${WALLET_METRIC_VERSION}
      AND credibility_metrics_valid = true
      AND completed_positions >= 10
  `);
  console.log(JSON.stringify({ strata: strata.rows, notAudited: notAudited.rows[0], auditedEligible: auditedEligible.rows[0] }, null, 2));
}

void main();
