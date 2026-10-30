#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

const WALLET = "0xad529df14c293d77984a0137990a1441b25211ac";

async function main() {
  const db = getDb();
  const r = await db!.execute(sql`
    select
      count(*)::int as events,
      count(*) filter (where asset_id is not null and trim(asset_id) <> '')::int as with_asset,
      count(distinct asset_id) filter (where asset_id is not null and trim(asset_id) <> '')::int as distinct_assets,
      count(*) filter (where market_condition_id is not null and trim(market_condition_id) <> '')::int as with_condition
    from wallet_ledger_events
    where lower(wallet_address) = lower(${WALLET})
  `);
  const r2 = await db!.execute(sql`
    select count(distinct asset_id)::int as assets_with_any_condition
    from wallet_ledger_events
    where lower(wallet_address) = lower(${WALLET})
      and market_condition_id is not null and trim(market_condition_id) <> ''
  `);
  console.log(JSON.stringify({ ...r.rows[0], ...r2.rows[0] }, null, 2));
}

void main();
