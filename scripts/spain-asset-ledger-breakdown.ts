#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";
import { fetchClosedPositions } from "@/lib/polymarket";

const w = "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";
const asset =
  "4394372887385518214471608448209527405727552777602031099972143344338178308080";

async function main() {
  const db = getDb();
  const contractMix = await db.execute(sql`
    select contract_address, count(*)::int as n
    from wallet_ledger_events
    where lower(wallet_address)=${w}
    group by contract_address
    order by n desc
    limit 12
  `);
  const blockRange = await db.execute(sql`
    select min(block_number)::bigint as min_block, max(block_number)::bigint as max_block
    from wallet_ledger_events
    where lower(wallet_address)=${w} and asset_id=${asset}
  `);
  const breakdown = await db.execute(sql`
    select event_type, source, contract_address,
      count(*)::int as n,
      sum(case when event_type='BUY' then cash_usd else 0 end)::float as buy_cash,
      sum(case when event_type='SELL' then cash_usd else 0 end)::float as sell_cash
    from wallet_ledger_events
    where lower(wallet_address)=${w} and asset_id=${asset}
    group by event_type, source, contract_address
    order by n desc
  `);
  const closed = await fetchClosedPositions(w, { limit: 500 });
  const row = closed.find((p) => p.asset === asset || p.asset_id === asset);
  console.log(
    JSON.stringify(
      {
        contractMix: contractMix.rows,
        blockRange: blockRange.rows[0],
        breakdown: breakdown.rows,
        apiRow: row ?? null,
      },
      null,
      2
    )
  );
}

void main();
