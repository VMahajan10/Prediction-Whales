#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

const w = "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";
const cid =
  "0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892";
const asset =
  "4394372887385518214471608448209527405727552777602031099972143344338178308080";

async function main() {
  const db = getDb();
  const byCondition = await db.execute(sql`
    select count(*)::int as n, coalesce(sum(cash_usd),0)::float as cash_sum
    from wallet_ledger_events
    where lower(wallet_address)=${w} and market_condition_id=${cid}
  `);
  const byAsset = await db.execute(sql`
    select count(*)::int as n, coalesce(sum(cash_usd),0)::float as cash_sum
    from wallet_ledger_events
    where lower(wallet_address)=${w} and asset_id=${asset}
  `);
  const walletTotals = await db.execute(sql`
    select count(*)::int as events,
      min(block_timestamp) as min_ts,
      max(block_timestamp) as max_ts
    from wallet_ledger_events
    where lower(wallet_address)=${w}
  `);
  console.log(JSON.stringify({ byCondition: byCondition.rows[0], byAsset: byAsset.rows[0], walletTotals: walletTotals.rows[0] }, null, 2));
}

void main();
