#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

async function main() {
  const db = getDb();
  const r = await db.execute(sql`
    select dedupe_key, log_index, tx_hash, event_type, cash_usd
    from wallet_ledger_events
    where wallet_address='0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6'
      and source='polygon' and (log_index is null or log_index='')
    limit 5
  `);
  console.log(JSON.stringify(r.rows, null, 2));
}

void main();
