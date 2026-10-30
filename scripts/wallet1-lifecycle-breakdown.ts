#!/usr/bin/env tsx
import "../tests/preload-env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

const WALLET =
  process.argv[2]?.toLowerCase() ??
  "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6";
const MV = "phase2e1-v1";

async function main() {
  const db = getDb();
  if (!db) {
    console.error("no db");
    process.exit(1);
  }

  const summary = await db.execute(sql`
    select
      count(*)::int as total_lifecycles,
      count(*) filter (where completed)::int as completed,
      count(*) filter (where completed and realized_pnl is not null)::int as completed_with_pnl,
      count(*) filter (where completion_type = 'fully_exited')::int as fully_exited,
      count(*) filter (where completion_type = 'held_through_resolution')::int as held_through_resolution,
      count(*) filter (where exclusion_reason is not null)::int as excluded,
      count(*) filter (where exclusion_reason = 'requires_merge_split_resolution')::int as merge_split,
      count(*) filter (where not completed and buy_notional > 0)::int as incomplete_with_buys,
      count(*) filter (where not completed and buy_notional > 0 and sell_notional > 0)::int as incomplete_partial_exit,
      count(*) filter (where not completed and buy_notional > 0 and sell_notional <= 0.01)::int as incomplete_no_sell,
      count(*) filter (where resolution_final = true)::int as gamma_final_true,
      count(*) filter (where resolution_final = false)::int as gamma_final_false,
      count(*) filter (where resolution_final is null)::int as gamma_final_null
    from wallet_position_lifecycles
    where lower(wallet_address) = lower(${WALLET})
      and metric_version = ${MV}
  `);

  const requiring = await db.execute(sql`
    select count(distinct condition_id)::int as conditions_requiring_resolution
    from wallet_position_lifecycles
    where lower(wallet_address) = lower(${WALLET})
      and metric_version = ${MV}
      and (
        completion_type = 'held_through_resolution'
        or (
          not completed
          and buy_notional > 0
          and sell_notional < buy_notional * 0.999
          and coalesce(exclusion_reason, '') != 'requires_merge_split_resolution'
        )
      )
  `);

  const unresolvedHeld = await db.execute(sql`
    select count(*)::int as n
    from wallet_position_lifecycles
    where lower(wallet_address) = lower(${WALLET})
      and metric_version = ${MV}
      and completion_type = 'held_through_resolution'
      and coalesce(resolution_final, false) = false
  `);

  const openSharesProxy = await db.execute(sql`
    select count(*)::int as n
    from wallet_position_lifecycles
    where lower(wallet_address) = lower(${WALLET})
      and metric_version = ${MV}
      and not completed
      and buy_notional > 0
      and (buy_notional - sell_notional - resolution_payout) > 1
  `);

  console.log(JSON.stringify({ wallet: WALLET, ...summary.rows[0] }, null, 2));
  console.log(JSON.stringify(requiring.rows[0], null, 2));
  console.log(
    JSON.stringify(
      {
        held_through_resolution_but_gamma_not_final: unresolvedHeld.rows[0],
        incomplete_likely_still_holding: openSharesProxy.rows[0],
      },
      null,
      2
    )
  );
}

void main();
