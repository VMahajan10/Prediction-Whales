#!/usr/bin/env tsx
import "../tests/preload-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/crossmarket/store/db";

async function main() {
  const db = getDb();
  if (!db) process.exit(1);
  const statements = [
    `ALTER TABLE "wallet_position_lifecycles"
  DROP CONSTRAINT IF EXISTS "wallet_position_lifecycles_position_version_unique"`,
    `DELETE FROM wallet_position_lifecycles AS victim
USING wallet_position_lifecycles AS keeper
WHERE victim.wallet_address = keeper.wallet_address
  AND victim.metric_version = keeper.metric_version
  AND victim.asset_id = keeper.asset_id
  AND victim.lifecycle_episode = keeper.lifecycle_episode
  AND victim.id <> keeper.id
  AND (
    keeper.buy_notional > victim.buy_notional
    OR (keeper.buy_notional = victim.buy_notional AND keeper.id > victim.id)
  )`,
    `ALTER TABLE "wallet_position_lifecycles"
  ADD CONSTRAINT "wallet_position_lifecycles_position_version_unique"
  UNIQUE ("wallet_address", "asset_id", "metric_version", "lifecycle_episode")`,
  ];
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
  console.log("applied 0034");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
