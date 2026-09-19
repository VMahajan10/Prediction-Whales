#!/usr/bin/env tsx
import "./preload-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { WALLET_METRIC_VERSION } from "@/lib/walletLedger/indexed/metricVersion";

async function main(): Promise<void> {
  const manifest = JSON.parse(
    readFileSync(
      join(process.cwd(), "tmp/wallet-history/phase2e2-stageC-cohort.json"),
      "utf8"
    )
  ) as { wallets: Array<{ wallet: string }> };
  const wallets = manifest.wallets.map((w) => w.wallet.toLowerCase());
  const db = getDb();
  const r = await db.execute(sql`
    SELECT
      count(*)::int in_cohort_with_metrics,
      count(*) FILTER (WHERE credibility_metrics_valid = true)::int valid,
      count(*) FILTER (WHERE credibility_metrics_valid = true AND completed_positions >= 10)::int eligible
    FROM wallet_historical_metrics
    WHERE metric_version = ${WALLET_METRIC_VERSION}
      AND lower(wallet_address) = ANY(${wallets})
  `);
  console.log(JSON.stringify(r.rows[0], null, 2));
}

void main();
