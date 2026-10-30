#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

const w = "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";

async function main() {
  const db = getDb();
  const r = await db.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (where source='polygon' and (log_index is null or log_index=''))::int as polygon_missing_log_index,
      count(*) filter (where dedupe_key like 'synthetic|%')::int as synthetic_keys
    from wallet_ledger_events where wallet_address=${w}
  `);
  console.log(JSON.stringify(r.rows[0], null, 2));
}

void main();
