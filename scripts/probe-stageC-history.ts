#!/usr/bin/env tsx
import "./preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

async function main(): Promise<void> {
  const db = getDb();
  const r = await db.execute(sql`
    SELECT
      (SELECT count(DISTINCT lower(wallet_address))::int FROM wallet_ledger_events) AS wallets_with_events,
      (SELECT count(DISTINCT lower(wallet_address))::int FROM wallet_history_coverage) AS wallets_with_coverage,
      (SELECT count(*)::int FROM whale_registry WHERE hydration_status = 'complete' AND resolved_bets_count >= 10) AS complete_ge10
  `);
  console.log(JSON.stringify(r.rows[0], null, 2));
}

void main();
