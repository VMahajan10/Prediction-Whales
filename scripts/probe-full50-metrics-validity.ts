import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";

async function main(): Promise<void> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT s.status, m.history_validity, count(*)::int AS c
    FROM wallet_shadow_batch_status s
    LEFT JOIN wallet_historical_metrics m
      ON lower(m.wallet_address) = lower(s.wallet_address)
     AND m.metric_version = ${WALLET_METRIC_VERSION}
    WHERE s.batch_id = 'phase2e1-full50-v2'
    GROUP BY s.status, m.history_validity
    ORDER BY s.status, m.history_validity
  `);
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? [];
  console.log(JSON.stringify(rows, null, 2));
}

void main().catch(console.error);
