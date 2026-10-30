#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

const wallet = (process.argv[2] ?? "").toLowerCase();
const mv = "phase2e1-v1";

async function main() {
  const db = getDb();
  if (!db || !wallet) process.exit(1);

  const net = await db.execute(sql`
    select
      sum(realized_pnl) filter (where completed and realized_pnl is not null) as net_completed,
      sum(case when realized_pnl > 0 then realized_pnl else 0 end) filter (where completed) as gp,
      sum(case when realized_pnl < 0 then abs(realized_pnl) else 0 end) filter (where completed) as gl,
      count(*) filter (where completed and realized_pnl is not null) as n
    from wallet_position_lifecycles
    where lower(wallet_address) = lower(${wallet})
      and metric_version = ${mv}
  `);
  console.log(JSON.stringify(net.rows[0], null, 2));

  const dup = await db.execute(sql`
    select count(*)::int as duplicate_episode_groups
    from (
      select asset_id, lifecycle_episode
      from wallet_position_lifecycles
      where lower(wallet_address) = lower(${wallet})
        and metric_version = ${mv}
      group by asset_id, lifecycle_episode
      having count(*) > 1
    ) t
  `);
  console.log(JSON.stringify(dup.rows[0], null, 2));
}

void main();
